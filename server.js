// RoxTown Carnage — Node server: static files + WebSocket transport around shared/game.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const S = require('./shared/game.js');

const PORT = +process.env.PORT || 8080;
const LAG = +process.env.LAG || 0; // simulated one-way latency for testing (ms)
const BASE = {
  bots: process.env.BOTS !== undefined ? +process.env.BOTS : 0,
  frags: +process.env.FRAGS || 10,
  minutes: +process.env.MINUTES || 10,
  arsenal: process.env.ARSENAL === '1',
  police: process.env.POLICE !== '0',
  seed: +process.env.SEED || 0,
  mapSize: Math.max(0, ['small', 'medium', 'large'].indexOf(String(process.env.MAP_SIZE || 'medium').toLowerCase())),
  islands: Math.max(0, Math.min(2, +process.env.ISLANDS || 0)),
  traffic: process.env.TRAFFIC !== undefined ? +process.env.TRAFFIC : undefined,
};
let game = S.createGame(BASE);
const humans = () => [...game.players.values()].filter((p) => !p.bot).length;
// Who picks the city is settled on the start screen: each open start screen checks in with GET /city every second or
// so, and while nobody is playing the one that has been waiting longest is the host. Everyone else sees the host's
// choices, locked, and whoever hits the streets first builds the host's city.
const lobby = new Map(); // start-screen id -> { since, seen, n, o }
const cleanOpts = (o) => ({ ms: Math.max(0, Math.min(2, o.ms | 0)), is: Math.max(0, Math.min(2, o.is | 0)), b: Math.max(0, Math.min(8, o.b | 0)), k: Math.max(1, Math.min(5, o.k | 0 || 3)) });
function lobbyHost() {
  const now = Date.now();
  let best = null;
  for (const [id, e] of lobby) {
    if (now - e.seen > 5000) { lobby.delete(id); continue; }
    if (!best || e.since < best.e.since) best = { id, e };
  }
  return best;
}
function cityFor(o, lid) {
  const h = lobbyHost();
  if (lid) lobby.delete(lid);
  if (!o || humans() > 0) return;
  const { ms, is, b, k } = cleanOpts(h && h.id !== lid ? h.e.o : o); // someone else is hosting from the start screen: their city
  if (ms !== game.map.size || is !== game.map.islands) game = S.createGame({ ...BASE, seed: 0, mapSize: ms, islands: is, bots: b });
  game.setBots(b); game.setSkill(k);
}

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  // opened as /games/crosstown (no slash): add it, or the page would look for its scripts one folder up
  const last = url.split('/').pop();
  if (url.length > 1 && last && !last.includes('.') && last !== 'city') { res.writeHead(301, { Location: req.url.replace(/^([^?]*)/, '$1/') }); return res.end(); }
  // works at the site root or under a sub-folder (cPanel can mount the app at e.g. /roxtown): everything is
  // one flat folder, so only the last part of the path matters
  url = '/' + (url.split('/').pop() || '');
  let file;
  if (url === '/city') { // for the lobby: what's running right now
    const q = new URLSearchParams(req.url.split('?')[1] || ''), lid = String(q.get('l') || '').slice(0, 16);
    if (lid) {
      const e = lobby.get(lid) || { since: Date.now() };
      e.seen = Date.now(); e.n = String(q.get('n') || 'Someone').replace(/[^\p{L}\p{N} _.!?'-]/gu, '').slice(0, 16) || 'Someone';
      e.o = cleanOpts({ ms: +q.get('ms'), is: +q.get('is'), b: +q.get('b'), k: +q.get('k') });
      lobby.set(lid, e);
    }
    const h = humans() ? null : lobbyHost();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      humans: humans(), up: Math.round((Date.now() - STARTED) / 1000), ms: game.map.size, is: game.map.islands, ...game.botInfo(), waiting: lobby.size,
      host: h ? { me: h.id === lid, n: h.e.n, ...h.e.o } : null,
    }));
  }
  if (url === '/shared.js') file = path.join(__dirname, 'shared', 'shared.js');
  else if (url === '/fight.js') file = path.join(__dirname, 'shared', 'fight.js');
  else {
    if (url === '/') url = '/index.html';
    file = path.normalize(path.join(PUB, url));
    if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': path.extname(file) === '.html' ? 'no-store' : 'no-cache' });
    res.end(data);
  });
});

// Problems are written to errors.log next to this file (and the console), and the game keeps running: one bad tick
// shouldn't throw everyone off the server.
const LOG = path.join(__dirname, 'errors.log');
let logged = 0;
function logError(where, err) {
  const line = `${new Date().toISOString()} ${where}: ${err && err.stack ? err.stack : err}\n`;
  console.error(line);
  if (logged++ < 200) fs.appendFile(LOG, line, () => {});
}
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandled promise', e));
const STARTED = Date.now();
fs.appendFile(LOG, `${new Date().toISOString()} server started (pid ${process.pid})\n`, () => {});

// play alerts: when a human joins, ask the relay to push a phone alert (ntfy) to everyone signed up on alerts.html.
// The relay sends at most one every 15 minutes. NOTIFY_URL=off turns it off (or points it at another relay).
const NOTIFY_URL = process.env.NOTIFY_URL || 'https://worms-relay.roxgamez.workers.dev/notify';
function notifyPlaying(name) {
  if (/^(off|0|false)$/i.test(NOTIFY_URL) || typeof fetch !== 'function') return;
  fetch(NOTIFY_URL + '?game=gta&name=' + encodeURIComponent(String(name || '').slice(0, 16)), { signal: AbortSignal.timeout(8000) })
    .catch((e) => logError('play alert', e));
}

const wss = new WebSocketServer({ server });
// keep-alive: a ping every 15 s keeps proxies from closing a quiet line, and a player whose connection died without
// closing is dropped after 45 s instead of standing in the street forever
setInterval(() => {
  for (const ws of wss.clients) {
    if (Date.now() - (ws.alive || 0) > 45000) { ws.terminate(); continue; }
    try { ws.ping(); } catch {}
  }
}, 15000);
wss.on('connection', (ws) => {
  ws.alive = Date.now();
  ws.on('pong', () => { ws.alive = Date.now(); });
  const out = (s) => { if (ws.readyState === 1) ws.send(s); };
  let conn = null; // joins the game on its first message, after the city is settled
  const handle = (m) => {
    if (!conn) {
      if (m.t !== 'j') return;
      cityFor(m.o, m.l);
      conn = game.connect(LAG ? (s) => setTimeout(() => out(s), LAG) : out);
      conn.message(m);
      if (conn.player) notifyPlaying(conn.player.name);
      return;
    }
    conn.message(m);
  };
  ws.on('message', (raw) => {
    ws.alive = Date.now();
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const run = () => { try { handle(m); } catch (e) { logError('message ' + m.t, e); } };
    if (LAG) setTimeout(run, LAG); else run();
  });
  ws.on('close', () => { if (conn) conn.close(); });
});

let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  try { game.advance(Number(now - last) / 1e9); } catch (e) { logError('tick', e); }
  last = now;
}, 4);

server.listen(PORT, () => console.log(`RoxTown Carnage running on http://localhost:${PORT}  (map seed ${game.seed}, ${S.MAP_SIZES[game.map.size].toLowerCase()} city, ${game.map.islands} island${game.map.islands === 1 ? '' : 's'})`));
