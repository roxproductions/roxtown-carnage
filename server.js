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
  stat: (n, k, v) => lbStat(n, k, v), // the leaderboard's totals
  idle: process.env.IDLE !== undefined ? +process.env.IDLE : 60, // seconds without touching anything before a player goes back to the start page; 0: never
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
  if (url.length > 1 && last && !last.includes('.') && last !== 'city' && last !== 'restart' && last !== 'log' && last !== 'leaders' && last !== 'err' && last !== 'errors') { res.writeHead(301, { Location: req.url.replace(/^([^?]*)/, '$1/') }); return res.end(); }
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
      v: S.VERSION, humans: humans(), names: [...game.players.values()].filter((p) => !p.bot).map((p) => p.name).slice(0, 4), up: Math.round((Date.now() - STARTED) / 1000), tick: LAGW.last, ms: game.map.size, is: game.map.islands, ...game.botInfo(), waiting: lobby.size,
      host: h ? { me: h.id === lid, n: h.e.n, ...h.e.o } : null,
    }));
  }
  if (url === '/leaders') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(leaders()));
    return;
  }
  if (url === '/log') {
    const k = new URL(req.url, 'http://x').searchParams.get('k');
    if (k && k === LOG_KEY) { logPage(res); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  if (url === '/err' && req.method === 'POST') { // a player's browser hit a JavaScript error (see errlog.js)
    let body = '';
    req.on('data', (c) => { if (body.length < 6000) body += c; });
    req.on('end', () => {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      let b = {}; try { b = JSON.parse(body); } catch {}
      ERR.record(b, req.headers['user-agent'], ip);
      res.writeHead(204); res.end();
    });
    return;
  }
  if (url === '/errors') {
    const q = new URL(req.url, 'http://x').searchParams, k = q.get('k');
    if (!(k && k === LOG_KEY)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    if (q.get('seen')) { ERR.markSeen(); res.writeHead(302, { Location: 'errors?k=' + encodeURIComponent(k) }); res.end(); return; }
    ERR.page(k, (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); });
    return;
  }
  if (url === '/restart') {
    // the page found the server running older code than it has on disk (new files uploaded, not loaded yet):
    // restart to load them. Only ever does anything when there is newer code waiting, so it can't be abused.
    let disk = '';
    try { disk = (fs.readFileSync(path.join(__dirname, 'shared', 'shared.js'), 'utf8').match(/S\.VERSION = '([^']+)'/) || [])[1] || ''; } catch {}
    const ok = AUTO_RESTART && !!disk && disk !== S.VERSION && Date.now() - lastRestartReq > 10000;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ running: S.VERSION, disk, restarting: ok, auto: AUTO_RESTART }));
    if (ok) {
      lastRestartReq = Date.now();
      logError('restart', new Error('restart asked for from the page: ' + S.VERSION + ' -> ' + disk));
      for (const c of wss.clients) try { c.close(4000, 'server update'); } catch {}
      setTimeout(() => process.exit(0), 400);
    }
    return;
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
try { const st = fs.statSync(LOG); if (st.size > 2e6) { const t = fs.readFileSync(LOG, 'utf8'); fs.writeFileSync(LOG, t.slice(-1e6)); } } catch {} // keep it from growing forever
function logError(where, err) {
  const line = `${new Date().toISOString()} ${where}: ${err && err.stack ? err.stack : err}\n`;
  console.error(line);
  if (logged++ < 200) fs.appendFile(LOG, line, () => {});
}
process.on('uncaughtException', (e) => { logError('uncaught', e); try { ERR.serverCrash('crash', e); } catch {} });
process.on('unhandledRejection', (e) => { logError('unhandled promise', e); try { ERR.serverCrash('unhandled promise', e); } catch {} });
const STARTED = Date.now();
fs.appendFile(LOG, `${new Date().toISOString()} server started (pid ${process.pid})\n`, () => {});

// Phone alerts (ntfy, shared with Worms Rox!): when someone walks into an empty city, ping the relay's /notify, which
// pushes to everyone who signed up on alerts.html (at most one alert every 15 minutes). ALERTS=0 turns it off.
const ALERT_URL = process.env.ALERT_URL || 'https://worms-relay.roxgamez.workers.dev/notify';
let lastAlert = 0, lastRestartReq = 0;
function playAlert(name, test) {
  if (process.env.ALERTS === '0') return;
  if (!test) { if (Date.now() - lastAlert < 15 * 60 * 1000) return; lastAlert = Date.now(); }
  const who = String(name || 'Someone').replace(/[^\p{L}\p{N} _.!?'-]/gu, '').slice(0, 16) || 'Someone';
  const https = require('https');
  // through the relay (it keeps the shared cooldown and the alert log); if the relay can't be reached or ntfy turned
  // it down, try again, and in the end post to ntfy.sh straight from here
  const viaRelay = (n) => {
    const done = (why) => { if (n < 2) setTimeout(() => viaRelay(n + 1), 4000 * (n + 1)); else { logError('alert', new Error('relay: ' + why + ', posting to ntfy directly')); direct(); } };
    try {
      https.get(ALERT_URL + '?game=gta&name=' + encodeURIComponent(who) + (test ? '&testntfy' : ''), { timeout: 8000 }, (r) => {
        let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => { t = t.trim(); if (r.statusCode === 200 && (t === 'sent' || t === 'cooldown')) return; done('HTTP ' + r.statusCode + ' ' + t.slice(0, 40)); });
      }).on('error', (e) => done(e.message)).on('timeout', function () { this.destroy(new Error('timed out')); });
    } catch (e) { done(e.message); }
  };
  const direct = () => {
    try {
      const rq = https.request('https://ntfy.sh/' + (process.env.NTFY_TOPIC || 'roxtown-carnage'), { method: 'POST', timeout: 8000, headers: {
        Title: 'RoxTown Carnage - game on!', Tags: 'video_game', Priority: 'high', Click: 'https://roxproductions.se/games/crosstown/' } }, (r) => {
        r.resume(); if (r.statusCode >= 300) logError('alert', new Error('ntfy.sh answered ' + r.statusCode));
      });
      rq.on('error', (e) => logError('alert', e)).on('timeout', function () { this.destroy(new Error('ntfy timed out')); });
      rq.end(who + ' is playing right now. Come join!');
    } catch (e) { logError('alert', e); }
  };
  viaRelay(0);
}

// updates to players are compressed (about a quarter of the size: snapshots are JSON, which squeezes well). Level 1 is
// plenty and costs next to nothing; tiny messages aren't worth it.
const wss = new WebSocketServer({ server, perMessageDeflate: { zlibDeflateOptions: { level: 1, memLevel: 8 }, threshold: 512, concurrencyLimit: 8, serverNoContextTakeover: false, clientNoContextTakeover: true } });
// keep-alive: a ping every 15 s keeps proxies from closing a quiet line, and a player whose connection died without
// closing is dropped after 45 s instead of standing in the street forever
setInterval(() => {
  for (const ws of wss.clients) {
    if (Date.now() - (ws.alive || 0) > 45000) { ws.terminate(); continue; }
    try { ws.ping(); } catch {}
  }
}, 15000);
// ---------------------------------------------------------------- the play log
// Who played and when: one line per play session in plays.log (next to errors.log, not in public/), and a page to
// read it: /log?k=KEY. KEY is the LOG_KEY environment variable, or else the one made up on the first start and kept
// in log-key.txt in the app folder (open it in cPanel's File Manager). No IP addresses are kept: just the name,
// times, the device type and the time zone the browser reports (which says roughly where in the world they are).
// ---------------------------------------------------------------- the leaderboard
// Lifetime totals for everyone who has played, by name (case doesn't matter): kills, deaths, matches won, races won,
// fist fights won, best score and time played. Kept in leaderboard.json, public at /leaders (the start page shows it).
const LB_FILE = path.join(__dirname, 'leaderboard.json');
let LB = {};
try { LB = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) || {}; } catch {}
let lbDirty = false;
const lbKey = (n) => String(n || '').trim().toLowerCase().slice(0, 16);
function lbRow(n) {
  const k = lbKey(n);
  if (!k || /^player\d*$/.test(k)) return null; // no name given: not on the board
  return LB[k] || (LB[k] = { n: String(n).trim().slice(0, 16), kills: 0, deaths: 0, matches: 0, races: 0, fights: 0, best: 0, ms: 0, last: 0 });
}
function lbStat(n, k, v) { const r = lbRow(n); if (!r) return; r[k] = (r[k] || 0) + v; r.n = String(n).trim().slice(0, 16); r.last = Date.now(); lbDirty = true; }
function lbSave() { if (!lbDirty) return; lbDirty = false; try { fs.writeFileSync(LB_FILE + '.tmp', JSON.stringify(LB)); fs.renameSync(LB_FILE + '.tmp', LB_FILE); } catch {} }
setInterval(lbSave, 20000);
process.on('exit', lbSave);
function leaders() {
  const all = Object.values(LB).filter((r) => r.ms > 60000 || r.kills || r.matches || r.races || r.fights);
  const top = (f) => all.slice().sort((a, b) => f(b) - f(a) || b.kills - a.kills).slice(0, 15).map((r) => ({ n: r.n, kills: r.kills, deaths: r.deaths, matches: r.matches, races: r.races, fights: r.fights, best: r.best, h: Math.round(r.ms / 360000) / 10 }));
  return { kills: top((r) => r.kills), matches: top((r) => r.matches), races: top((r) => r.races), fights: top((r) => r.fights), best: top((r) => r.best), time: top((r) => r.ms), players: all.length };
}

const PLAYS = path.join(__dirname, 'plays.log'), KEYF = path.join(__dirname, 'log-key.txt');
let LOG_KEY = process.env.LOG_KEY || '';
if (!LOG_KEY) {
  try { LOG_KEY = fs.readFileSync(KEYF, 'utf8').trim(); } catch {}
  if (!LOG_KEY) { LOG_KEY = require('crypto').randomBytes(9).toString('base64url'); try { fs.writeFileSync(KEYF, LOG_KEY + '\n'); } catch {} }
}
try { if (fs.statSync(PLAYS).size > 4e6) { const lines = fs.readFileSync(PLAYS, 'utf8').trim().split('\n'); fs.writeFileSync(PLAYS, lines.slice(-8000).join('\n') + '\n'); } } catch {} // keep it from growing for ever
const openPlays = new Set();
const ERR = require('./errlog.js')({ dir: __dirname, S, LOG, getKey: () => LOG_KEY });
function device(ua) {
  ua = ua || '';
  const kind = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'computer';
  const os = /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [kind, os, br].filter(Boolean).join(' · ');
}
function endPlay(pl) {
  if (!pl || pl.done) return;
  pl.done = true; openPlays.delete(pl);
  const p = pl.conn && pl.conn.player;
  const row = { t0: pl.t0, t1: Date.now(), n: (p && p.name) || pl.n, dev: pl.dev, tz: pl.tz, fr: p ? p.frags : 0, de: p ? p.deaths : 0, sc: p ? p.score : 0, peak: pl.peak, cut: pl.cut ? 1 : 0 };
  if (row.t1 - row.t0 < 3000) return; // opened and gone at once: not a game
  const lr = lbRow(row.n);
  if (lr) { lr.ms += row.t1 - row.t0; lr.best = Math.max(lr.best || 0, row.sc | 0); lr.last = row.t1; lbDirty = true; }
  try { fs.appendFileSync(PLAYS, JSON.stringify(row) + '\n'); } catch {}
}
setInterval(() => { const h = humans(); for (const pl of openPlays) pl.peak = Math.max(pl.peak, h); }, 5000);
process.on('exit', () => { for (const pl of [...openPlays]) { pl.cut = true; endPlay(pl); } }); // a restart: still write down who was on
function logPage(res) {
  let rows = [];
  try { rows = fs.readFileSync(PLAYS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const now = Date.now();
  for (const pl of openPlays) { const p = pl.conn && pl.conn.player; rows.push({ t0: pl.t0, t1: now, n: (p && p.name) || pl.n, dev: pl.dev, tz: pl.tz, fr: p ? p.frags : 0, de: p ? p.deaths : 0, sc: p ? p.score : 0, peak: pl.peak, live: 1 }); }
  rows.sort((a, b) => b.t0 - a.t0);
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fmtT = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16);
  const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  // per day: sessions, different names, total time played
  const days = new Map();
  for (const r of rows) { const d = fmtT(r.t0).slice(0, 10), o = days.get(d) || { n: 0, names: new Set(), ms: 0 }; o.n++; o.names.add(r.n); o.ms += r.t1 - r.t0; days.set(d, o); }
  const dayRows = [...days].slice(0, 30).map(([d, o]) => `<tr><td>${d}</td><td>${o.n}</td><td>${o.names.size}</td><td>${dur(o.ms)}</td><td class="nm">${esc([...o.names].join(', '))}</td></tr>`).join('');
  const sess = rows.slice(0, 500).map((r) => `<tr${r.live ? ' class="live"' : ''}><td>${fmtT(r.t0)}</td><td><b>${esc(r.n)}</b>${r.live ? ' <span class="dot">● playing</span>' : ''}</td><td>${dur(r.t1 - r.t0)}${r.cut ? ' <span title="the server restarted while they played">↻</span>' : ''}</td><td>${r.fr | 0} / ${r.de | 0}</td><td>${r.sc | 0}</td><td>${r.peak || 1}</td><td>${esc(r.dev)}</td><td>${esc(r.tz)}</td></tr>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>RoxTown Carnage · play log</title>
<style>body{margin:0;padding:24px;background:#0e0b14;color:#ddd;font:14px/1.45 system-ui,sans-serif}h1{font:28px Impact,'Arial Black',sans-serif;letter-spacing:1px;color:#ffd21f;margin:0 0 4px}h2{font-size:13px;letter-spacing:2px;color:#9c94a8;text-transform:uppercase;margin:28px 0 8px}
.sub{color:#8a8494;margin:0 0 8px}table{border-collapse:collapse;width:100%;max-width:1100px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #241f2e;white-space:nowrap}th{font-size:11px;letter-spacing:1px;color:#9c94a8;text-transform:uppercase}td.nm{white-space:normal;color:#aaa}
tr.live td{background:#162418}.dot{color:#3ee06a;font-size:12px}.wrap{overflow-x:auto}</style>
<h1>RoxTown Carnage · play log</h1><p class="sub">Times in Swedish time. ${rows.length} sessions logged · ${openPlays.size} playing now · server ${esc(S.VERSION)} · <a style="color:#8fd0ff" href="errors?k=${encodeURIComponent(LOG_KEY)}">errors.log</a></p>
<h2>By day</h2><div class="wrap"><table><tr><th>Day</th><th>Sessions</th><th>Players</th><th>Time played</th><th>Who</th></tr>${dayRows || '<tr><td colspan=5>Nobody yet.</td></tr>'}</table></div>
<h2>Sessions</h2><div class="wrap"><table><tr><th>Started</th><th>Name</th><th>Played</th><th>Frags / deaths</th><th>Score</th><th>Most on at once</th><th>Device</th><th>Time zone</th></tr>${sess || '<tr><td colspan=8>Nobody yet.</td></tr>'}</table></div>`);
}

wss.on('connection', (ws, req) => {
  let play = null;
  ws.alive = Date.now();
  ws.on('pong', () => { ws.alive = Date.now(); });
  const out = (s) => { if (ws.readyState === 1) ws.send(s); };
  let conn = null; // joins the game on its first message, after the city is settled
  const handle = (m) => {
    if (!conn) {
      if (m.t !== 'j') return;
      if (m.tn) playAlert(m.n, true); // ?testntfy on the address: alert now, no waiting
      else if (humans() === 0 && !m.carry) playAlert(m.n);
      cityFor(m.o, m.l);
      conn = game.connect(LAG ? (s) => setTimeout(() => out(s), LAG) : out);
      play = { t0: Date.now(), n: String(m.n || '').slice(0, 16), dev: device(req && req.headers['user-agent']), tz: String(m.tz || '').slice(0, 40), peak: humans() + 1, conn };
      openPlays.add(play);
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
  ws.on('close', () => { endPlay(play); if (conn) conn.close(); });
});

let last = process.hrtime.bigint();
// lag watch: how long the game's work takes on this machine. A tick has 16.7 ms; anything over that and every player
// sees a stutter. The numbers are on /city (tick), and a minute with stutters goes into errors.log, so it shows up
// on the errors page next to crashes.
const LAGW = { n: 0, sum: 0, max: 0, over: 0, gap: 0, t0: Date.now(), lastLog: 0, last: null };
setInterval(() => {
  const now = process.hrtime.bigint(), gap = Number(now - last) / 1e6;
  try { game.advance(Number(now - last) / 1e9); } catch (e) { logError('tick', e); }
  const work = Number(process.hrtime.bigint() - now) / 1e6;
  last = now;
  if (game.players.size) {
    LAGW.n++; LAGW.sum += work; LAGW.max = Math.max(LAGW.max, work); if (work > 16.7) LAGW.over++; if (gap > 50) LAGW.gap++;
  }
  if (Date.now() - LAGW.t0 > 60000) {
    LAGW.last = { avg: LAGW.n ? +(LAGW.sum / LAGW.n).toFixed(2) : 0, max: +LAGW.max.toFixed(1), over: LAGW.over, gaps: LAGW.gap, mem: Math.round(process.memoryUsage().rss / 1048576) };
    if ((LAGW.over > 3 || LAGW.gap > 3) && Date.now() - LAGW.lastLog > 10 * 60000) {
      LAGW.lastLog = Date.now();
      logError('lag', `server stutter: ${LAGW.over} slow ticks and ${LAGW.gap} pauses in the last minute (worst ${LAGW.max.toFixed(0)} ms, average ${LAGW.last.avg} ms; ${humans()} people, ${game.players.size} players with bots, ${LAGW.last.mem} MB)`);
    }
    Object.assign(LAGW, { n: 0, sum: 0, max: 0, over: 0, gap: 0, t0: Date.now() });
  }
}, 4);

// Restart by itself after an upload: when the server's own code changes on disk it waits until the upload has been
// quiet for 15 s, then exits, and the host (Passenger, as in cPanel's "Setup Node.js App") starts the new code on the
// next visit. On by default under Passenger; AUTO_RESTART=1 turns it on anywhere else (then something must start the
// server again, e.g. pm2 or a systemd service), AUTO_RESTART=0 turns it off.
const AUTO_RESTART = process.env.AUTO_RESTART ? process.env.AUTO_RESTART === '1' : typeof PhusionPassenger !== 'undefined' || !!process.env.PASSENGER_APP_ENV;
if (AUTO_RESTART) {
  const files = ['server.js', 'package.json', ...fs.readdirSync(path.join(__dirname, 'shared')).filter((f) => f.endsWith('.js')).map((f) => 'shared/' + f)].map((f) => path.join(__dirname, f));
  let quietTimer = null;
  const changed = (f) => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      logError('auto restart', new Error('code changed on disk (' + path.relative(__dirname, f) + '): restarting to load it'));
      for (const c of wss.clients) try { c.close(4000, 'server update'); } catch {}
      setTimeout(() => process.exit(0), 300);
    }, 15000);
  };
  for (const f of files) fs.watchFile(f, { interval: 4000 }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) changed(f); });
}

server.listen(PORT, () => console.log(`RoxTown Carnage running on http://localhost:${PORT}  (map seed ${game.seed}, ${S.MAP_SIZES[game.map.size].toLowerCase()} city, ${game.map.islands} island${game.map.islands === 1 ? '' : 's'})`));
