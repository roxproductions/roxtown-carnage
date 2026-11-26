'use strict';
// RoxTown Carnage: the error log, made useful.
//   - JavaScript errors from players' browsers arrive at /err and go into errors-browser.jsonl (one JSON object per
//     line): when, which version they were running, the error and where, what they were doing (on foot, which car, in
//     a fight...), and on what kind of device.
//   - Server problems still go to errors.log (see logError in server.js), as plain text.
//   - The page (/errors?k=KEY) groups the same error together (how often, how many players, first and last seen),
//     puts errors from the version that's running now first, tucks the ones from older versions away (that player
//     just had an old copy open), marks what's NEW since you last pressed "mark all as seen", and squashes the pile
//     of "server started" lines into one line of restarts.
//   - A brand-new kind of error on the current version (or a server crash) sends a push to a private ntfy topic
//     (error-alert-topic.txt, made up at random on first start; subscribe to it in the ntfy app to get them).
const fs = require('fs');
const path = require('path');
const https = require('https');

module.exports = function errlog({ dir, S, LOG, getKey }) {
  const BFILE = path.join(dir, 'errors-browser.jsonl');
  const SEENF = path.join(dir, 'errors-seen.json');
  const TOPICF = path.join(dir, 'error-alert-topic.txt');
  // keep the files from growing forever
  for (const f of [BFILE, LOG]) try { const st = fs.statSync(f); if (st.size > 3e6) { const t = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, t.slice(t.indexOf('\n', t.length - 1.5e6) + 1)); } } catch {}
  let topic = process.env.ERR_TOPIC || '';
  if (!topic) { try { topic = fs.readFileSync(TOPICF, 'utf8').trim(); } catch {} }
  if (!topic) { topic = 'roxtown-errors-' + require('crypto').randomBytes(6).toString('hex'); try { fs.writeFileSync(TOPICF, topic + '\n'); } catch {} }

  const cut = (v, n) => String(v == null ? '' : v).replace(/\s+$/g, '').slice(0, n);
  // what makes two errors "the same": the message without its line numbers, and the file it happened in
  function sig(m) {
    const at = String(m).match(/ @ ([\w.-]+):\d+:\d+$/);
    const msg = String(m).replace(/ @ [\w.-]+:\d+:\d+$/, '').replace(/\d{3,}/g, '#').replace(/'[^']{20,}'/g, "'…'");
    return msg + (at ? ' @ ' + at[1] : '');
  }
  const known = new Set();
  try { for (const ln of fs.readFileSync(BFILE, 'utf8').split('\n')) { if (!ln) continue; try { known.add(sig(JSON.parse(ln).m)); } catch {} } } catch {}
  const serverKnown = new Set();
  let pushes = [];
  function push(title, body) {
    const now = Date.now(); pushes = pushes.filter((t) => now - t < 86400000);
    if (pushes.length >= 12 || !topic) return; pushes.push(now);
    try {
      const rq = https.request('https://ntfy.sh/' + topic, { method: 'POST', timeout: 8000, headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: 'warning', Priority: 'default', Click: 'https://roxproductions.se/games/crosstown/errors?k=' + encodeURIComponent(getKey()) } }, (r) => r.resume());
      rq.on('error', () => {}).on('timeout', function () { this.destroy(); });
      rq.end(body.slice(0, 600));
    } catch {}
  }
  const rate = new Map(); let count = 0;
  // a browser's report: {v, m, s, ctx, u}
  function record(b, ua, ip) {
    const w = rate.get(ip) || [0, 0]; if (Date.now() - w[0] > 60000) { w[0] = Date.now(); w[1] = 0; } w[1]++; rate.set(ip, w);
    if (rate.size > 500) rate.clear();
    if (w[1] > 10 || count++ > 2000) return;
    const e = { t: Date.now(), v: cut(b.v, 20), m: cut(b.m, 400), s: cut(b.s, 1500), ctx: cut(b.ctx, 300), dev: device(ua), ua: cut(ua, 200),
      who: require('crypto').createHash('sha1').update(ip + 'rox').digest('hex').slice(0, 6) };
    fs.appendFile(BFILE, JSON.stringify(e) + '\n', () => {});
    const k = sig(e.m);
    if (!known.has(k)) {
      known.add(k);
      if (e.v === S.VERSION) push('RoxTown: new error in ' + e.v, e.m + (e.ctx ? '\n' + e.ctx : '') + '\n' + e.dev);
    }
  }
  // server.js calls this for crashes (uncaught exceptions / promise rejections)
  function serverCrash(where, err) {
    const first = String(err && err.message ? err.message : err).split('\n')[0];
    const k = where + ': ' + first.replace(/\d{3,}/g, '#');
    if (serverKnown.has(k)) return; serverKnown.add(k);
    push('RoxTown server: ' + where, first + '\n' + String((err && err.stack) || '').split('\n').slice(1, 4).join('\n'));
  }
  function device(ua) {
    ua = String(ua || '');
    const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other';
    const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/.test(ua) ? 'curl' : 'browser';
    return br + ' on ' + os;
  }
  function readSeen() { try { return JSON.parse(fs.readFileSync(SEENF, 'utf8')).t || 0; } catch { return 0; } }
  function markSeen() { try { fs.writeFileSync(SEENF, JSON.stringify({ t: Date.now() })); } catch {} }

  // ---------------------------------------------------------------- the page
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const when = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16);
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  function page(k, cb) {
    const seenAt = readSeen();
    fs.readFile(BFILE, 'utf8', (e1, btxt) => fs.readFile(LOG, 'utf8', (e2, stxt) => {
      // browser errors, grouped
      const groups = new Map();
      for (const ln of String(btxt || '').split('\n')) {
        if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
        const key = sig(e.m), g = groups.get(key) || { key, n: 0, who: new Set(), devs: new Map(), vers: new Set(), first: e.t, last: 0, latest: null };
        g.n++; g.who.add(e.who); g.devs.set(e.dev, (g.devs.get(e.dev) || 0) + 1); g.vers.add(e.v); g.first = Math.min(g.first, e.t);
        if (e.t >= g.last) { g.last = e.t; g.latest = e; }
        groups.set(key, g);
      }
      const all = [...groups.values()].sort((a, b) => b.last - a.last);
      const cur = all.filter((g) => g.vers.has(S.VERSION)), old = all.filter((g) => !g.vers.has(S.VERSION));
      // server log: restarts squashed into bursts; everything else grouped by its first line
      const ents = []; for (const ln of String(stxt || '').split('\n')) { if (/^\d{4}-\d\d-\d\dT/.test(ln)) ents.push(ln); else if (ents.length && ln.trim()) ents[ents.length - 1] += '\n' + ln; }
      const starts = [], sgroups = new Map();
      for (const x of ents) {
        const t = Date.parse(x.slice(0, 24)), rest = x.slice(25);
        if (/^server started/.test(rest)) { starts.push(t); continue; }
        if (/^browser \(/.test(rest)) continue; // the old format of browser errors (before errors-browser.jsonl)
        const head = rest.split('\n')[0], key = head.replace(/\d{3,}/g, '#');
        const g = sgroups.get(key) || { key, n: 0, first: t, last: 0, latest: '' };
        g.n++; g.first = Math.min(g.first, t); if (t >= g.last) { g.last = t; g.latest = rest; }
        sgroups.set(key, g);
      }
      const bursts = []; for (const t of starts.sort((a, b) => a - b)) { const b = bursts[bursts.length - 1]; if (b && t - b.last < 90000) { b.last = t; b.n++; } else bursts.push({ first: t, last: t, n: 1 }); }
      const day = Date.now() - 86400000, week = Date.now() - 7 * 86400000;
      const sg = [...sgroups.values()].sort((a, b) => b.last - a.last);
      const newCur = cur.filter((g) => g.last > seenAt).length, newSrv = sg.filter((g) => g.last > seenAt).length;
      const card = (g, isNew, oldv) => {
        const e = g.latest, devs = [...g.devs].sort((a, b) => b[1] - a[1]).map(([d, n]) => d + (n > 1 ? ' ×' + n : '')).join(', ');
        return `<div class="g${oldv ? ' old' : ''}">${isNew ? '<span class="new">NEW</span>' : ''}<b class="n">×${g.n}</b><div class="m">${esc(e.m)}</div>`
          + `<div class="meta">${g.who.size} player${g.who.size === 1 ? '' : 's'} · last ${ago(g.last)} (${when(g.last)}) · first ${when(g.first)} · ${esc(devs)} · version${g.vers.size > 1 ? 's' : ''} ${esc([...g.vers].join(', '))}</div>`
          + (e.ctx ? `<div class="ctx">What they were doing: ${esc(e.ctx)}</div>` : '')
          + (e.s ? `<details><summary>stack</summary><pre>${esc(e.s)}</pre></details>` : '') + '</div>';
      };
      const scard = (g) => `<div class="g">${g.last > seenAt ? '<span class="new">NEW</span>' : ''}<b class="n">×${g.n}</b><div class="m">${esc(g.latest.split('\n')[0])}</div><div class="meta">last ${ago(g.last)} (${when(g.last)}) · first ${when(g.first)}</div>`
        + (g.latest.includes('\n') ? `<details><summary>details</summary><pre>${esc(g.latest)}</pre></details>` : '') + '</div>';
      const css = 'body{font:14px/1.45 system-ui,sans-serif;background:#12141c;color:#ddd;margin:0;padding:18px;max-width:980px}a{color:#8fd0ff}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;color:#ffd21f}'
        + '.sum{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.sum div{background:#1b1e29;border:1px solid #2a2e3a;border-radius:10px;padding:10px 14px;min-width:120px}.sum b{display:block;font-size:24px;color:#fff}.sum .bad b{color:#ff7b7b}.sum .ok b{color:#7dffa8}'
        + '.g{position:relative;background:#1b1e29;border:1px solid #2a2e3a;border-radius:10px;padding:10px 14px 10px 64px;margin:8px 0}.g.old{opacity:.6}.n{position:absolute;left:14px;top:10px;font-size:18px;color:#ffb36b}.m{font:13px ui-monospace,Menlo,monospace;color:#fff;word-break:break-word}'
        + '.meta{font-size:12px;color:#8a93a8;margin-top:4px}.ctx{font-size:12px;color:#c9d1e0;margin-top:4px}.new{float:right;background:#ff3b5c;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px}'
        + 'details{margin-top:6px}summary{cursor:pointer;color:#8fd0ff;font-size:12px}pre{white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;color:#9aa3b8;margin:6px 0 0}.btn{display:inline-block;background:#ffd21f;color:#000;font-weight:700;padding:7px 12px;border-radius:8px;text-decoration:none;margin-right:8px}.quiet{color:#6b7488}';
      const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>RoxTown errors</title><style>${css}</style>`
        + `<h1>RoxTown Carnage · errors</h1><div class="quiet">Running ${esc(S.VERSION)} · <a href="log?k=${esc(k)}">play log</a></div>`
        + `<div class="sum"><div class="${newCur ? 'bad' : 'ok'}"><b>${newCur}</b>new in this version</div><div><b>${cur.reduce((s, g) => s + g.n, 0)}</b>browser errors, this version</div>`
        + `<div class="${newSrv ? 'bad' : 'ok'}"><b>${newSrv}</b>new server problems</div><div><b>${bursts.filter((b) => b.last > day).length}</b>restarts, last 24 h</div></div>`
        + `<a class="btn" href="errors?k=${esc(k)}&seen=1">Mark all as seen</a><span class="quiet">${seenAt ? 'last marked ' + ago(seenAt) : 'never marked'}</span>`
        + `<h2>Errors in players' browsers · this version (${esc(S.VERSION)})</h2>` + (cur.length ? cur.map((g) => card(g, g.last > seenAt)).join('') : '<p class="quiet">None so far. 🎉</p>')
        + `<h2>Server problems</h2>` + (sg.length ? sg.slice(0, 40).map(scard).join('') : '<p class="quiet">None.</p>')
        + `<h2>Restarts</h2><p class="quiet">${bursts.filter((b) => b.last > day).length} in the last 24 h, ${bursts.filter((b) => b.last > week).length} in the last 7 days (starts within 90 s of each other count as one: a deploy, or the host waking the app up). Latest: ${bursts.slice(-8).reverse().map((b) => when(b.last) + (b.n > 1 ? ' (×' + b.n + ')' : '')).join(' · ') || 'none'}</p>`
        + (old.length ? `<h2>From older versions</h2><p class="quiet">Players who still had an older copy of the game open. Probably fixed already: check the newest version above.</p><details><summary>${old.length} kind${old.length === 1 ? "" : "s"} of error</summary>${old.slice(0, 60).map((g) => card(g, false, true)).join('')}</details>` : '')
        + `<h2>Phone alerts for new errors</h2><p class="quiet">A new kind of error in the current version, or a server crash, sends a push (at most 12 a day). To get them, subscribe to this topic in the ntfy app: <b style="color:#ffd21f;user-select:all">${esc(topic)}</b>. Keep the name to yourself.</p>`;
      cb(html);
    }));
  }
  return { record, serverCrash, page, markSeen, device, topic: () => topic };
};
