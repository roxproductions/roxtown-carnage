// RoxTown Carnage — browser client: rendering, prediction, HUD, sound.
(() => {
  'use strict';
  const { TILE, T, K, DT } = S;
  // JavaScript errors in the player's browser go to the error log: the game server's errors.log (read it at
  // errors?k=KEY), or the relay's log page when there's no game server (the claude.ai version). A few per page at most.
  (function () {
    let sent = 0; const seen = new Set();
    const onServer = /^https?:$/.test(location.protocol) && !/claude|anthropic/.test(location.hostname);
    const report = (m, st) => {
      m = String(m || 'error').slice(0, 400); if (sent >= 8 || seen.has(m)) return; seen.add(m); sent++;
      let ctx = ''; try { ctx = errCtx(); } catch {}
      const body = JSON.stringify({ g: 'gta', v: S.VERSION, m, s: String(st || '').slice(0, 1500), ctx, u: location.href.split('?')[0] });
      try { fetch(onServer ? 'err' : 'https://worms-relay.roxgamez.workers.dev/err', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {}); } catch {}
    };
    addEventListener('error', (e) => { if (e && (e.message || e.error)) report((e.message || '') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno + ':' + e.colno : ''), e.error && e.error.stack); });
    addEventListener('unhandledrejection', (e) => { const r = e && e.reason; report('unhandled promise: ' + (r && r.message ? r.message : r), r && r.stack); });
  })();
  const cv = document.getElementById('game');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  // Graphics: 'auto' (sharp, but drops the resolution step by step when frames start to drop, and climbs back when
  // there's room), 'sharp' (always full resolution) or 'fast' (low resolution, no water shimmer: for slow machines)
  let GFX = 'auto', autoScale = 1;
  try { GFX = localStorage.getItem('cc_gfx') || 'auto'; } catch {}
  function resize() {
    const nat = Math.min(2, window.devicePixelRatio || 1);
    DPR = Math.max(0.5, GFX === 'sharp' ? nat : GFX === 'fast' ? Math.min(1, nat) * 0.7 : nat * autoScale);
    W = cv.width = Math.floor(innerWidth * DPR);
    H = cv.height = Math.floor(innerHeight * DPR);
  }
  addEventListener('resize', resize);
  resize();
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpA = (a, b, t) => a + S.angDiff(b, a) * t;
  const rnd = (a, b) => a + Math.random() * (b - a);
  // easing: everything that moves eases in or out instead of snapping
  const E = {
    inQuad: (t) => t * t,
    outQuad: (t) => 1 - (1 - t) * (1 - t),
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  };
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  // ================================================================ lobby
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const nameEl = document.getElementById('name');
  nameEl.value = store.get('cc_name') || '';
  // a colour of your own, picked at random each time you start
  let myColor = S.PLAYER_COLORS[Math.floor(Math.random() * S.PLAYER_COLORS.length)];
  const ctrlMode = 'tank'; // classic: Left/Right turn, Up walks forward
  // INFO: the controls, hidden until you open them
  { const ib = document.getElementById('infobtn'), ke = document.getElementById('keys');
    if (ib && ke) ib.onclick = () => { ke.hidden = !ke.hidden; ib.textContent = ke.hidden ? '⌨ HOW TO PLAY ▸' : '⌨ HOW TO PLAY ▾'; ib.setAttribute('aria-expanded', String(!ke.hidden)); }; }
  // FULLSCREEN: the game fills the screen and locks the keyboard, so Chrome hands its shortcuts (Ctrl/Cmd+W, T, N,
  // Esc...) to the game instead of acting on them. Hold Esc to get out. Browsers only allow the lock in fullscreen.
  let fsMode = store.get('cc_fs') || 'full';
  const fsEl = document.getElementById('fssel');
  if (fsEl) {
    const can = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) && document.fullscreenEnabled !== false;
    if (!can) { fsEl.style.display = 'none'; if (fsEl.previousElementSibling) fsEl.previousElementSibling.style.display = 'none'; fsMode = 'win'; }
    [...fsEl.children].forEach((b) => {
      b.className = b.dataset.v === fsMode ? 'on' : '';
      b.onclick = () => { fsMode = b.dataset.v; store.set('cc_fs', fsMode); [...fsEl.children].forEach((x) => (x.className = x === b ? 'on' : '')); };
    });
  }
  function goFullscreen() {
    const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      Promise.resolve(req.call(el, { navigationUI: 'hide' }))
        .then(() => navigator.keyboard && navigator.keyboard.lock ? navigator.keyboard.lock() : null)
        .catch(() => {});
    } catch {}
  }
  let todMode = store.get('cc_tod') || 'day'; // N in the game (or the menu) changes it
  // server version: the same city options as the artifact; whoever starts an empty server picks them
  const lobbyId = Math.random().toString(36).slice(2, 12);
  const srvOpt = { b: 0, k: Math.max(1, Math.min(5, +(store.get('cc_skill') || 3))), ms: +(store.get('cc_msize') ?? 1), is: +(store.get('cc_isl') ?? 0) };
  setTimeout(() => {
    if (window.CC_TRANSPORT) return; // the artifact's room script runs its own lobby
    const optEl = document.getElementById('artopts'), stEl = document.getElementById('roomst'), nm = document.getElementById('netmode');
    if (!optEl) return;
    optEl.hidden = false;
    if (nm) { nm.style.display = 'none'; if (nm.previousElementSibling) nm.previousElementSibling.style.display = 'none'; }
    let city = null;
    // who picks the city: the server names a host while nobody is playing; once a city runs, it is the city's
    const lead = () => {
      if (!city) return null;
      if (city.humans) return { me: false, run: true, ms: city.ms, is: city.is, b: city.b ? 1 : 0, k: city.k };
      return city.host && !city.host.me ? city.host : null;
    };
    const status = () => {
      if (!city) { stEl.textContent = ''; return; }
      const L = lead(), sz = (o) => `${(S.MAP_SIZES[o.ms] || 'MEDIUM').toLowerCase()} city${o.is ? ` with ${o.is === 1 ? 'one island' : 'two islands'}` : ''}`;
      const w = Math.max(0, (city.waiting || 0) - 1), more = w ? ` ${w} more ${w === 1 ? 'is' : 'are'} on the start screen.` : '';
      if (L && L.run) stEl.textContent = `${city.humans} playing in a ${sz(L)}.${more}`;
      else if (L) stEl.textContent = `${String(L.n).toUpperCase()} IS THE HOST and picks the city. You can hit the streets now or wait for them.`;
      else stEl.textContent = w ? `YOU ARE THE HOST: your choices set the city for everyone.${more}` : 'The server is empty. You are the host: you pick the city.';
      for (const p of paints) p();
      if (city.v) versionWarn(city.v);
      lobbyRunning(!!(L && L.run), city.humans ? `● ${city.humans} playing now${city.names && city.names.length ? ' · ' + city.names.join(', ') : ''}` : '');
    };
    const paints = [];
    const seg = (id, key, sk) => {
      const el = document.getElementById(id);
      if (!el) return;
      const paint = () => { const L = lead(), v = L ? L[key] : srvOpt[key]; [...el.children].forEach((b) => { b.className = b.dataset.v === String(v) ? 'on' : ''; b.disabled = !!L; }); };
      [...el.children].forEach((b) => (b.onclick = () => { if (b.disabled) return; srvOpt[key] = +b.dataset.v; store.set(sk, b.dataset.v); paint(); pollNow(); }));
      paints.push(paint); paint();
    };
    seg('botsel', 'b', 'cc_bots_unused'); seg('msize', 'ms', 'cc_msize'); seg('islsel', 'is', 'cc_isl');
    { // bot skill slider
      const el = document.getElementById('skillsel'), nm = document.getElementById('skilln');
      const paint = () => { const L = lead(), v = L ? (L.k || 3) : srvOpt.k; if (document.activeElement !== el || L) el.value = v; el.disabled = !!L; nm.textContent = S.BOT_SKILLS[+el.value]; };
      el.oninput = () => { nm.textContent = S.BOT_SKILLS[+el.value]; };
      el.onchange = () => { if (el.disabled) return; srvOpt.k = +el.value; store.set('cc_skill', el.value); paint(); pollNow(); };
      paints.push(paint); paint();
    }
    let timer = 0;
    const pollNow = () => {
      clearTimeout(timer);
      if (joined) return;
      const q = new URLSearchParams({ l: lobbyId, n: nameEl.value.trim() || 'Someone', b: srvOpt.b, k: srvOpt.k, ms: srvOpt.ms, is: srvOpt.is });
      fetch('city?' + q, { cache: 'no-store' }).then((r) => r.json()).then((c) => { if (!joined) { city = c; status(); } }).catch(() => {});
      timer = setTimeout(pollNow, 1200);
    };
    const poll = pollNow;
    nameEl.addEventListener('change', pollNow);
    poll();
  }, 0);
  // while someone is already playing, the start screen only offers to join them: the city options are theirs
  // a game going on: JOIN CURRENT GAME right under the name, and nothing to choose about the city
  function lobbyRunning(run, sub) {
    const co = document.getElementById('cityopts'), go = document.getElementById('go'), jc = document.getElementById('joincur'), js = document.getElementById('joinsub'), lb = document.getElementById('lobby');
    if (lb) lb.classList.toggle('running', !!run);
    if (js && sub) js.textContent = sub;
    if (co) co.hidden = !!run;
    if (go) go.hidden = !!run;
    if (jc) jc.hidden = !run;
  }
  { const jc = document.getElementById('joincur'); if (jc) jc.onclick = () => join(); }
  window.CC_LOBBY_RUNNING = lobbyRunning; // the artifact's room script calls it too
  document.getElementById('go').onclick = join;
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  // ================================================================ network state
  let net = null, myId = 0, map = null, pkDefs = [], pkActive = '';
  const roster = new Map();
  const scores = new Map();
  let snaps = [], clockOff = null, me = null, game = { st: 'play', tl: 0, fl: 20, win: 0 };
  let seq = 0, pending = [], outbox = [], ping = 0;
  let pred = { mode: 'none' };
  const off = { x: 0, y: 0, a: 0 };

  let joined = false;
  // idle: a minute without touching a key or the screen sends you back to the start page (the server does the same)
  const IDLE_MS = 60000;
  let lastInput = performance.now();
  for (const ev of ['keydown', 'pointerdown', 'touchstart', 'wheel']) addEventListener(ev, () => { lastInput = performance.now(); }, { capture: true, passive: true });
  function goIdle() {
    if (!joined) return;
    joined = false;
    try { sessionStorage.setItem('cc_idle', '1'); } catch {}
    leaveGame();
    setTimeout(() => location.reload(), 120);
  }
  setInterval(() => { if (joined && performance.now() - lastInput > IDLE_MS) goIdle(); }, 2000);
  { // back on the start page after being idle: say why
    let was = false; try { was = sessionStorage.getItem('cc_idle') === '1'; sessionStorage.removeItem('cc_idle'); } catch {}
    if (was) {
      const n = document.createElement('div'); n.className = 'idlenote';
      n.textContent = 'You were sent back here after a minute without touching anything.';
      const tag = document.querySelector('#lobby .sub');
      if (tag) tag.after(n);
    }
  }

  function join() {
    if (joined) return;
    joined = true; lastInput = performance.now();
    const name = nameEl.value.trim() || 'Player' + Math.floor(Math.random() * 900 + 100);
    store.set('cc_name', name);
    document.getElementById('lobby').style.display = 'none';
    if (fsMode === 'full') goFullscreen();
    Audio.init();
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) setupTouch();
    const onClose = (why) => { document.getElementById('msgt').textContent = why || 'DISCONNECTED'; document.getElementById('msg').style.display = 'flex'; };
    if (window.CC_TRANSPORT) {
      // in-page transport (solo game or shared room), supplied by the page
      net = window.CC_TRANSPORT({ name, color: myColor, onMsg, onClose });
      INTERP = net.interp || INTERP;
    } else {
      // A dropped connection reconnects by itself a few times before it gives up and shows the button. You come back
      // into the same city as a new arrival (your score starts again); if the server itself restarted, it's a new city.
      let ws = null, tries = 0, everOpen = false;
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '');
      const msgEl = document.getElementById('msg'), msgT = document.getElementById('msgt');
      const open = () => {
        ws = new WebSocket(url);
        ws.onopen = () => {
          if (everOpen) { lowMsg = { txt: 'RECONNECTED', t: 2.5 }; }
          everOpen = true; tries = 0; msgEl.style.display = 'none';
          ws.send(JSON.stringify({ t: 'j', n: name, c: myColor, o: srvOpt, l: lobbyId, tn: /[?&]testntfy\b/.test(location.search) ? 1 : 0, tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })() }));
        };
        ws.onmessage = (e) => onMsg(JSON.parse(e.data));
        ws.onclose = (e) => {
          // 1006: the line just dropped (network, Wi-Fi, a proxy timing out); 1001/1012: the server went down or restarted
          const why = e.code === 4000 ? 'GAME UPDATED' : e.code === 1001 || e.code === 1012 ? 'SERVER RESTARTED' : 'CONNECTION LOST';
          console.warn('[RoxTown] connection closed', e.code, e.reason || '');
          if (tries < 6) {
            const wait = [500, 1000, 2000, 3000, 5000, 8000][tries++];
            msgT.textContent = why + ' · RECONNECTING…'; msgEl.style.display = 'flex'; msgEl.classList.add('soft');
            setTimeout(open, wait);
          } else { msgEl.classList.remove('soft'); onClose('DISCONNECTED (' + e.code + ')'); }
        };
      };
      open();
      net = { send: (o) => ws.send(JSON.stringify(o)), ok: () => ws && ws.readyState === 1, interp: 90, minInterp: 70, // buffer adapts to each player's connection
        leave: () => { try { ws.onclose = null; if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'q' })); ws.close(1000, 'quit'); } catch {} } };
    }
  }
  const sendNet = (o) => { if (net && net.ok()) net.send(o); };
  // leaving (quit, idle, closing the tab): tell the game straight away, so the start page doesn't still show you playing
  function leaveGame() { try { if (net && net.leave) net.leave(); } catch {} }
  addEventListener('pagehide', leaveGame);
  setInterval(() => sendNet({ t: 'pi', c: performance.now(), r: Math.round(ping) }), 2000);


  // the server sends the version of the code it's running: a different one means it builds a different city from the
  // same seed (cars on the water, invisible walls), usually because new files were uploaded without restarting it
  function versionWarn(v) {
    let el = document.getElementById('verwarn');
    if (v === S.VERSION) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div'); el.id = 'verwarn';
      el.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:20;max-width:calc(100vw - 32px);background:#c4161c;color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:8px 14px;border:2px solid #000;box-shadow:3px 3px 0 #000;text-align:center';
      document.body.appendChild(el);
    }
    const btn = 'margin-left:10px;padding:3px 10px;font:700 13px system-ui,sans-serif;background:#ffd21f;color:#000;border:2px solid #000;cursor:pointer';
    if (v && v > S.VERSION) {
      el.innerHTML = '⚠ The game has been updated (' + v + '). <button style="' + btn + '">RELOAD</button>';
      el.querySelector('button').onclick = () => location.reload();
      return;
    }
    // older code on the server: offer to restart it (it only restarts if newer files are actually waiting on disk)
    if (el.dataset.busy) return;
    el.innerHTML = '⚠ The game server is running older code (' + (v || 'unknown') + ') than this page (' + S.VERSION + '), so the city will be wrong. <button style="' + btn + '">RESTART SERVER</button>';
    el.querySelector('button').onclick = async () => {
      el.dataset.busy = '1';
      el.textContent = 'Asking the server to restart…';
      try {
        const r = await (await fetch('restart', { cache: 'no-store' })).json();
        if (r.restarting) { el.textContent = 'Restarting the server with ' + r.disk + '… the page reloads in a moment.'; setTimeout(() => location.reload(), 5000); return; }
        el.textContent = r.disk === r.running ? '⚠ The new files are not on the server yet (it has ' + r.disk + '): upload the zip first, then try again.'
          : !r.auto ? '⚠ This server can\'t restart itself: restart it by hand.' : '⚠ A restart was just asked for: give it a few seconds, then reload.';
      } catch { el.textContent = '⚠ This server is too old to restart from here: restart the app once in cPanel (Setup Node.js App → Restart).'; }
      setTimeout(() => { delete el.dataset.busy; }, 8000);
    };
  }

  function onMsg(m) {
    if (m.t === 'kick') { goIdle(); return; } // the server timed us out
    if (m.t === 'w') {
      // (re)start: a new world, or the same city under a new host
      myId = m.id;
      versionWarn(m.v);
      snaps = []; clockOff = null; pending = []; outbox = []; onSnap.n = 0; pred = { mode: 'none' }; me = null; deathCam = null;
      scores.clear(); feed.length = 0;
      fight.pred = fight.pv = fight.last = null; fight.id = 0;
      pkAnim = [];
      if (map && map.seed === m.seed && map.size === (m.ms == null ? 1 : m.ms) && map.islands === (m.is | 0)) { pkDefs = m.pk.map(([id, x, y, k]) => ({ id, x, y, k })); return; }
      map = S.genMap(m.seed, { size: m.ms, islands: m.is }); sparkleTiles.clear();
      pkDefs = m.pk.map(([id, x, y, k]) => ({ id, x, y, k }));
      initWorld();
    } else if (m.t === 'r') {
      roster.clear();
      for (const [id, name, color, bot] of m.l) roster.set(id, { name, color, bot });
    } else if (m.t === 'po') {
      ping = performance.now() - m.c;
    } else if (m.t === 's' && map) onSnap(m);
  }

  function onSnap(s) {
    const now = performance.now();
    s.Pm = new Map(s.P.map((r) => [r[0], r]));
    s.Cm = new Map(s.C.map((r) => [r[0], r]));
    s.Rm = new Map(s.PR.map((r) => [r[0], r]));
    s.N = s.N || [];
    s.Nm = new Map(s.N.map((r) => [r[0], r]));
    const o = s.tm - now;
    if (clockOff === null || o > clockOff || Math.abs(o - clockOff) > 1000) clockOff = o;
    else clockOff += (o - clockOff) * 0.02;
    // online room: how far behind to draw other players depends on how evenly updates arrive
    if (net && net.interp) {
      onSnap.n = (onSnap.n || 0) + 1;
      if (onSnap.n <= 20) { onSnap.lastAt = 0; onSnap.gap = 0; onSnap.late = 0; } // just joined: the map is still being built, ignore that hiccup
      else if (onSnap.lastAt) {
        const gap = now - onSnap.lastAt, late = Math.max(0, clockOff - o); // late: this update arrived later than the best one
        onSnap.gap = onSnap.gap ? onSnap.gap * 0.9 + gap * 0.1 : gap;
        onSnap.late = Math.max(late, (onSnap.late || 0) * 0.995);
        INTERP = damp(INTERP, clamp(onSnap.gap * 1.2 + onSnap.late + 40, net.minInterp || 110, 900), 2, gap / 1000);
      }
      onSnap.lastAt = now;
    }
    snaps.push(s);
    if (snaps.length > 40) snaps.shift();
    if (s.sb) for (const r of s.sb) scores.set(r[0], r);
    game = s.g; pkActive = s.pk; me = s.me; brawlParse(s.g);
    // in a car fist fight? then the fight screen takes over (and there's nothing to predict)
    const myDu = myId && s.g.du ? s.g.du.find((r) => r[1] === myId || r[2] === myId) : null;
    for (const r of s.P) if (r[6]) lastCar.set(r[0], r[6]);
    // the red flash when you take damage
    if (me.al && hud.prevHp !== null && me.hp < hud.prevHp - 0.5) hud.hurt = Math.min(1, hud.hurt + 0.35 + (hud.prevHp - me.hp) / 50);
    hud.prevHp = me.al ? me.hp : null;
    // reconcile own entity with server state + replay unacknowledged inputs
    // how old the cars on your screen were when you pressed the keys the host has just played: the host
    // rewinds cars by this much when it checks you on foot, so a jump timed to what you see is what counts
    { const it = pending.find((i) => i.s === s.a); if (it && it.vt != null) { const v = clamp(s.tm - it.vt, 0, 1000); viewLag = viewLag == null ? v : viewLag + (v - viewLag) * 0.15; } }
    pending = pending.filter((i) => i.s > s.a);
    if (myDu || fight.id) fightSnap(myDu, s.a);
    const row = s.Pm.get(myId);
    if (!me.al || !row || myDu || (myBrawl && !bFree(myBrawlSt()))) pred = { mode: 'none' }; // knocked about in a brawl: just show where the game has you
    else if (me.car && row[6]) {
      const [x, y, a, vx, vy, spin, oil, t, up, z, vz, hm] = me.car;
      const fresh = { t, up: up || 0, x, y, a, vx, vy, spin, oil, drv: true, dead: false, z: z || 0, vz: vz || 0, hm: hm || 0 };
      for (const i of pending) {
        if (i.j && !S.carAir(map, fresh)) { fresh.vz = S.CAR_JUMP; fresh.z += 0.01; } // a car jump you pressed that the game hasn't seen yet
        S.stepCar(map, fresh, i.k, DT); pushOffCars(fresh, row[6], s);
      }
      if (pred.mode === 'car' && pred.id === row[6]) { off.x += pred.c.x - fresh.x; off.y += pred.c.y - fresh.y; off.a += S.angDiff(pred.c.a, fresh.a); }
      else { off.x = off.y = off.a = 0; }
      pred = { mode: 'car', id: row[6], c: fresh };
    } else if (me.ped) {
      const [x, y, a, kx, ky, z, vz, jvx, jvy, gz, sl, nj, ch] = me.ped;
      const fresh = { x, y, a, kx, ky, z: z || 0, vz: vz || 0, jvx: jvx || 0, jvy: jvy || 0, gz: gz || 0, sl: sl || 0, mv: 0, nj: nj || 0, ch: ch || 0 };
      for (const i of pending) { if (myBrawl) brawlStep(fresh, i.k); else S.stepPed(map, fresh, i.k, DT); }
      if (pred.mode === 'ped') { off.x += pred.p.x - fresh.x; off.y += pred.p.y - fresh.y; off.a += S.angDiff(pred.p.a, fresh.a); }
      else { off.x = off.y = off.a = 0; }
      pred = { mode: 'ped', p: fresh };
    }
    if (Math.hypot(off.x, off.y) > 160) { off.x = off.y = 0; off.a = 0; }
    // events (shots, explosions, hits...) happen at the snapshot's time: play them when the world on screen
    // reaches that moment, so a muzzle flash comes out of the gun as it's drawn, not ahead of it
    // ...except your own car's gun: your car is drawn ahead of that moment (it reacts to your keys at once), so
    // its shots play as soon as they arrive, from the gun on the car you see
    if (s.ev.length && pred.mode === 'car') {
      const own = s.ev.filter((e) => e[0] === 's' && e[7] === myId && e[6] === 30);
      if (own.length) { s.ev = s.ev.filter((e) => !own.includes(e)); for (const e of own) handleEvent(e, s); }
    }
    if (s.ev.length) evQ.push({ tm: s.tm, at: performance.now(), ev: s.ev, s });
  }
  const evQ = [];
  function flushEvents(rt) {
    const now = performance.now();
    while (evQ.length && (evQ[0].tm <= rt || now - evQ[0].at > 1200 || evQ.length > 90)) {
      const q = evQ.shift();
      Audio.hush = now - q.at > 1200; // back from a hidden tab: catch up silently instead of a wall of noise
      for (const e of q.ev) handleEvent(e, q.s);
      Audio.hush = false;
    }
  }

  function pushOffCars(c, ownId, snap) {
    const s = snap || snaps[snaps.length - 1];
    if (!s || c.t === S.HELI) return;
    for (const r of s.C) {
      if (r[0] === ownId || r[1] === S.HELI || Math.abs(r[3] - c.x) > 110 || Math.abs(r[4] - c.y) > 110) continue;
      const zc = c.z || 0, zr = r[12] || 0;
      if ((zc > zr && zc - zr > S.CARS[r[1]].h - 4) || (zr > zc && zr - zc > S.CARS[c.t].h - 4)) continue; // one is jumping over the other
      const C2 = S.CARS[r[1]];
      const h = S.boxOverlap(S.carBox(c), { x: r[3], y: r[4], ca: Math.cos(r[5]), sa: Math.sin(r[5]), hl: C2.len / 2, hw: C2.wid / 2 });
      if (!h) continue;
      const ox = c.x, oy = c.y;
      c.x -= h.nx * h.depth; c.y -= h.ny * h.depth;
      if (S.carHits(map, c)) { c.x = ox; c.y = oy; }
      const vn = c.vx * h.nx + c.vy * h.ny;
      if (vn > 0) { c.vx -= vn * h.nx * 1.25; c.vy -= vn * h.ny * 1.25; }
    }
  }

  // the bell on the start page: send a phone alert by hand (through the same relay the automatic alerts use)
  (function () {
    const bell = document.getElementById('bell'), tip = document.getElementById('belltip'), nm = document.getElementById('bellname'), nameEl = document.getElementById('name');
    if (!bell) return;
    const who = () => ((nameEl && nameEl.value) || store.get('cc_name') || '').trim().slice(0, 16) || 'Someone'; // the name you typed (or last played as)
    const showTip = (html, ms) => { tip.innerHTML = html; tip.classList.add('show'); clearTimeout(showTip.t); showTip.t = setTimeout(() => { tip.classList.remove('show'); setTimeout(reset, 200); }, ms); };
    const reset = () => { tip.innerHTML = '<b>Call people in!</b> Sends a phone alert to everyone following <b>roxtown-carnage</b> in the ntfy app: "<span id="bellname"></span> wants a game. Who\'s in?" (One every 2 minutes.)'; document.getElementById('bellname').textContent = who(); };
    bell.addEventListener('mouseenter', () => { const n = document.getElementById('bellname'); if (n) n.textContent = who(); });
    let busy = false;
    bell.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await fetch('https://worms-relay.roxgamez.workers.dev/notify?game=gta&manual&name=' + encodeURIComponent(who()));
        const t = await r.text();
        let res = t.trim();
        if (res === 'failed') { // the relay couldn't get through to ntfy: send it from this browser instead
          const d = await fetch('https://ntfy.sh/roxtown-carnage', { method: 'POST', body: who() + " wants a game. Who's in? Come play!",
            headers: { Title: 'RoxTown Carnage - anyone up for a game?', Tags: 'bell,video_game', Priority: 'high', Click: 'https://roxproductions.se/games/crosstown/' } }).catch(() => null);
          res = d && d.ok ? 'sent' : 'failed';
        }
        if (res === 'sent') showTip('<b>🔔 Alert sent!</b> Everyone following roxtown-carnage just got a ping. Jump in and wait for them.', 4000);
        else if (res === 'failed') showTip("<b>Couldn't reach ntfy just now.</b> Try again in a minute.", 4000);
        else showTip('<b>Someone just rang the bell.</b> One alert every 2 minutes: try again in a moment.', 3500);
      } catch (e) { showTip("<b>Couldn't send the alert from here.</b> Try from roxproductions.se/games/crosstown.", 4000); }
      busy = false;
    });
  })();

  // the leaderboard on the start page (the game server keeps it: not there in the claude.ai version)
  {
    const btn = document.getElementById('lbbtn'), box = document.getElementById('lb'), tab = document.getElementById('lbtab'), foot = document.getElementById('lbfoot');
    let data = null, cur = 'kills';
    const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    const COLS = { kills: ['kills', (r) => r.kills, (r) => r.deaths + ' deaths'], matches: ['matches won', (r) => r.matches, (r) => r.kills + ' kills'], races: ['races won', (r) => r.races, (r) => r.kills + ' kills'],
      fights: ['fist fights won', (r) => r.fights, (r) => r.kills + ' kills'], best: ['best score', (r) => r.best.toLocaleString('en'), (r) => r.matches + ' wins'], time: ['hours played', (r) => r.h, (r) => r.kills + ' kills'] };
    const render = () => {
      if (!data) return;
      const rows = (data[cur] || []).filter((r) => cur === 'time' ? r.h > 0 : cur === 'best' ? r.best > 0 : (r[cur] | 0) > 0), me = ((document.getElementById('name') || {}).value || '').trim().toLowerCase(), C = COLS[cur];
      tab.innerHTML = rows.length ? rows.map((r, i) => `<tr${r.n.toLowerCase() === me ? ' class="me"' : ''}><td class="rk">${i + 1}</td><td class="nm">${esc(r.n)}</td><td class="x">${esc(C[2](r))}</td><td class="v">${esc(C[1](r))}</td></tr>`).join('')
        : '<tr><td class="nm" style="font-weight:400;color:#8a8494">Nobody on this board yet. Go and change that.</td></tr>';
      foot.textContent = `Top 15 by ${C[0]} · ${data.players} players so far · play under the same name to keep adding to your totals`;
    };
    const load = () => fetch('leaders', { cache: 'no-store' }).then((r) => r.json()).then((j) => { data = j; if (btn) btn.hidden = false; render(); }).catch(() => {});
    if (btn && box && location.protocol.startsWith('http')) {
      load();
      btn.onclick = () => { box.hidden = !box.hidden; if (!box.hidden) load(); };
      document.getElementById('lbx').onclick = () => { box.hidden = true; };
      document.getElementById('lbtabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cur = b.dataset.k; for (const x of document.querySelectorAll('#lbtabs button')) x.classList.toggle('on', x === b); render(); };
      addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) box.hidden = true; });
    }
  }
  // the start page's artwork follows the mouse a little (each layer by its own depth)
  {
    const art = document.getElementById('art'), lob = document.getElementById('lobby');
    if (art && lob) lob.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      art.style.setProperty('--mx', ((e.clientX / innerWidth - 0.5) * 2).toFixed(3));
      art.style.setProperty('--my', ((e.clientY / innerHeight - 0.5) * 2).toFixed(3));
    });
  }

  // ================================================================ input
  const keys = new Set();
  const touchKeys = new Set();
  // the touch joystick: which way it's pushed (screen = world: up is north) and how far (0..1)
  const stick = { on: false, a: 0, m: 0 };
  // turn the stick into keys. On foot: walk that way (8 directions). In a vehicle: steer towards where it points and
  // drive, or back up if it points behind you. Holding TURRET (tank, boat): it aims the gun instead.
  function stickKeys() {
    if (!stick.on || stick.m < 0.28) return 0;
    let k = 0;
    if (pred.mode === 'car' && pred.c) {
      const tr = touchKeys.has(K.TUR) && (pred.c.t === S.TANK || pred.c.t === S.BOAT || pred.c.t === S.FIRE);
      const ts = tr && turretSeen.get(pred.id), heading = pred.c.a + (ts ? ts.tur : 0);
      const da = S.angDiff(stick.a, heading);
      if (tr) return Math.abs(da) > 0.06 ? (da > 0 ? K.RIGHT : K.LEFT) : 0;
      const back = Math.abs(da) > 2.3; // pulled the other way: reverse, steering so the back swings round
      const d2 = back ? S.angDiff(stick.a, heading + Math.PI) : da;
      if (Math.abs(d2) > 0.1) k |= (d2 > 0) !== back ? K.RIGHT : K.LEFT;
      k |= back ? K.DOWN : stick.m > 0.5 || Math.abs(da) < 1.2 ? K.UP : 0;
      return k;
    }
    const sec = Math.round(stick.a / (Math.PI / 4)) & 7; // 0 east, 2 south, 4 west, 6 north
    const DIRS = [K.RIGHT, K.RIGHT | K.DOWN, K.DOWN, K.DOWN | K.LEFT, K.LEFT, K.LEFT | K.UP, K.UP, K.UP | K.RIGHT];
    return K.ABS | DIRS[sec];
  }
  // GTA2 layout: arrows move, Ctrl fires, Space jumps (on foot) or handbrakes (in a car), Enter gets in/out, Z/X switch weapons.
  // On a Mac, Ctrl+arrows switches desktops, so Option fires too.
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const KEYMAP = {
    ArrowUp: K.UP, ArrowDown: K.DOWN, ArrowLeft: K.LEFT, ArrowRight: K.RIGHT,
    ControlLeft: K.FIRE, ControlRight: K.FIRE, Space: K.HAND, Tab: K.TUR,
  };
  if (IS_MAC) { KEYMAP.AltLeft = K.FIRE; KEYMAP.AltRight = K.FIRE; }
  const keysEl = document.querySelector('.keys');
  if (keysEl && IS_MAC) keysEl.innerHTML = keysEl.innerHTML.replace('<b>Ctrl</b>', '<b>Ctrl / Option</b>');
  if (IS_MAC) document.querySelectorAll('.mac-opt').forEach((e) => { e.innerHTML = '/ <kbd>Option</kbd>'; });
  const chatEl = document.getElementById('chat');
  let showScores = false;
  addEventListener('keydown', (e) => {
    if (!joined) return;
    if (document.activeElement === chatEl) {
      if (e.key === 'Enter') { const t = chatEl.value.trim(); if (t) sendNet({ t: 'c', m: t }); chatEl.value = ''; chatEl.style.display = 'none'; chatEl.blur(); }
      else if (e.key === 'Escape') { chatEl.value = ''; chatEl.style.display = 'none'; chatEl.blur(); }
      return;
    }
    if (e.code === 'Escape' && offer && !menuOpen) { e.preventDefault(); if (!e.repeat) answerOffer(false); return; } // walk away from the fight
    if (e.code === 'Escape') { e.preventDefault(); if (!e.repeat) setMenu(!menuOpen); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault(); // keep the browser's own shortcuts out of the game where it lets us
    if (menuOpen) { if (e.code === 'KeyM' && !e.repeat) { Audio.toggle(); refreshMenu(); } return; }
    if (KEYMAP[e.code] !== undefined || e.code === 'Enter' || ((inFight() || inBrawl()) && FKEYS[e.code])) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if ((inFight() || inBrawl()) && (FKEYS[e.code] || e.code === 'KeyH' || e.code === 'KeyF' || e.code === 'Enter')) return; // fight buttons, not weapon switching
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyF') act('e');
    else if (e.code === 'KeyX') act('n');
    else if (e.code === 'KeyZ') act('p');
    else if (e.code === 'KeyH') act('h');
    else if (e.code === 'Tab' && !(pred.mode === 'car' && pred.c && (pred.c.t === S.TANK || pred.c.t === S.BOAT || pred.c.t === S.FIRE))) act('tn'); // a burp, a fart or a taunt
    else if (e.code === 'KeyY' && offer) answerOffer(true);
    else if ((e.code === 'KeyQ' || e.code === 'Escape') && offer) answerOffer(false);
    else if (e.code === 'KeyR') Radio.next();
    else if (e.code === 'KeyK') lowMsg = { txt: Radio.toggle() ? 'RADIO ON' : 'RADIO OFF', t: 1.8 };
    else if (e.code === 'KeyN') {
      todMode = { day: 'night', night: 'cycle', cycle: 'day' }[todMode] || 'day';
      store.set('cc_tod', todMode);
      lowMsg = { txt: { day: 'DAYTIME', night: 'NIGHT TIME', cycle: 'DAY + NIGHT CYCLE' }[todMode], t: 2 };
    }
    else if (e.code === 'KeyM') Audio.toggle();
    else if (e.code === 'KeyT') { e.preventDefault(); keys.clear(); chatEl.style.display = 'block'; setTimeout(() => chatEl.focus(), 0); }
  });
  addEventListener('keyup', (e) => { keys.delete(e.code); });
  addEventListener('blur', () => keys.clear());
  function act(a) { sendNet({ t: 'a', a }); }
  // a fist fight on offer: both of you have to say yes
  let offer = null;
  const offEl = document.getElementById('offer'), offT = document.getElementById('offert'), offY = document.getElementById('offy'), offN = document.getElementById('offn'), offBar = document.querySelector('#offbar i');
  // kind: '' (a car jack turned into a fight offer), 'wait' (you asked from the menu: waiting for them),
  // 'asked' (someone challenged you from the menu)
  function showOffer(other, mode = 'd', kind = '') {
    offer = { other, until: performance.now() + 30000, wait: kind === 'wait' };
    const what = mode === 'b' ? 'STREET BRAWL' : 'FIST FIGHT', who = nm(other).toUpperCase();
    offT.textContent = kind === 'wait' ? `WAITING FOR ${who} TO TAKE ON A ${what}…` : kind === 'asked' ? `${who} CHALLENGES YOU TO A ${what}!` : `${what} WITH ${who}?`; // (you're both paused till you answer: Y to fight, Esc to walk away)
    offY.style.display = kind === 'wait' ? 'none' : ''; offN.firstChild.textContent = kind === 'wait' ? 'CALL IT OFF ' : 'WALK AWAY ';
    document.getElementById('offp').textContent = kind === 'wait' ? '⏸ BOTH PAUSED · THEY DECIDE' : '⏸ BOTH PAUSED · FIRST ANSWER DECIDES';
    offY.disabled = offN.disabled = false; offEl.style.display = 'flex';
    Audio.play('ding');
  }
  function hideOffer() { offer = null; offEl.style.display = 'none'; }
  function answerOffer(yes) {
    if (!offer) return;
    if (offer.wait && yes) return; // you asked: it's their answer
    act(yes ? 'y' : 'q');
    hideOffer(); // the first answer decides for both
  }
  offY.onclick = () => answerOffer(true); offN.onclick = () => answerOffer(false);
  setInterval(() => { if (!offer) return; const left = offer.until - performance.now(); if (left <= 0) hideOffer(); else offBar.style.width = (left / 300) + '%'; }, 100);

  // ---------------------------------------------------------------- menu (Esc)
  const menuEl = document.getElementById('menu');
  const $m = (id) => document.getElementById(id);
  let menuOpen = false, restartArm = 0;
  const TOD_NAMES = { day: 'DAY', night: 'NIGHT', cycle: 'DAY + NIGHT' };
  for (const [id, a] of [['mFightD', 'fxd'], ['mFightB', 'fxb']]) { const b = document.getElementById(id); if (b) b.addEventListener('click', () => { act(a); setMenu(false); }); }
  function setMenu(open) {
    menuOpen = open; menuEl.hidden = !open; keys.clear(); touchKeys.clear();
    if (open) { restartArm = 0; wireVolume(); refreshMenu(); $m('mClose').focus({ preventScroll: true }); }
    else if (document.activeElement && menuEl.contains(document.activeElement)) document.activeElement.blur();
  }
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function refreshMenu() {
    if (!menuOpen) return;
    const flip = (id, label, on) => { const b = $m(id); b.textContent = label + (on ? 'ON' : 'OFF'); b.classList.toggle('off', !on); };
    flip('mSound', 'SOUND: ', !Audio.muted);
    flip('mRadio', 'CAR RADIO: ', Radio.isOn);
    flip('mPolice', 'POLICE: ', !!game.po);
    $m('mTod').textContent = 'TIME: ' + TOD_NAMES[todMode];
    paintBots();
    const fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    $m('mFull').hidden = !fsOk;
    $m('mFull').textContent = document.fullscreenElement || document.webkitFullscreenElement ? 'EXIT FULL SCREEN' : 'FULL SCREEN';
    const armed = performance.now() < restartArm;
    $m('mRestart').textContent = armed ? 'CLICK AGAIN: RESTART FOR EVERYONE' : 'RESTART MATCH';
    $m('mRestart').classList.toggle('arm', armed);
    const tl = game.tl, mm = Math.floor(tl / 60), ss = String(tl % 60).padStart(2, '0');
    $m('mmatch').textContent = game.st === 'over' ? `NEXT MATCH IN ${tl}` : `${mm}:${ss} LEFT · FIRST TO ${game.fl} FRAGS`;
    const rows = [...roster.entries()].map(([id, r]) => ({ id, ...r, s: scores.get(id) || [id, 0, 0, 0, 0] }))
      .sort((a, b) => b.s[1] - a.s[1] || a.s[2] - b.s[2]);
    const top = rows.length ? rows[0].s[1] : 0;
    $m('mplayers').tBodies[0].innerHTML = rows.map((r) =>
      `<tr class="${r.id === myId ? 'me' : ''}"><td class="sw"><i style="background:${esc(r.color)}"></i></td><td>${esc(r.name)}</td>` +
      `<td class="${r.s[1] === top && top > 0 ? 'lead' : ''}">${r.s[1]}</td><td>${r.s[2]}</td><td>${r.bot ? '<span class="bot">BOT</span>' : r.id === myId ? Math.round(ping) : r.s[4] || '-'}</td></tr>`).join('');
  }
  // bots, from the menu: how many and how good, for everyone in the city (sent as one-step changes)
  let skillDrag = 0;
  function paintBots() {
    const bn = game.bn ?? 0, bs = game.bs || 3;
    $m('mBotsN').textContent = bn;
    $m('mBotsDn').disabled = bn <= 0; $m('mBotsUp').disabled = bn >= 8;
    if (performance.now() > skillDrag) $m('mSkill').value = bs;
    $m('mSkillN').textContent = S.BOT_SKILLS[+$m('mSkill').value];
  }
  $m('mBotsDn').onclick = () => { act('-'); game.bn = Math.max(0, (game.bn ?? 0) - 1); paintBots(); };
  $m('mBotsUp').onclick = () => { act('+'); game.bn = Math.min(8, (game.bn ?? 0) + 1); paintBots(); };
  $m('mSkill').oninput = () => { skillDrag = performance.now() + 1500; $m('mSkillN').textContent = S.BOT_SKILLS[+$m('mSkill').value]; };
  $m('mSkill').onchange = () => {
    const want = +$m('mSkill').value, have = game.bs || 3;
    for (let i = 0; i < Math.abs(want - have); i++) act(want > have ? '>' : '<');
    game.bs = want; skillDrag = performance.now() + 800; paintBots();
  };
  setInterval(refreshMenu, 250);
  $m('mSound').onclick = () => { Audio.toggle(); refreshMenu(); };
  // volume sliders: wired up the first time the menu opens (the sound system starts later than this)
  let volWired = false;
  function wireVolume() {
    if (volWired) return;
    volWired = true;
    for (const k of ['master', 'sfx', 'voice', 'radio']) {
      const el = $m('vol_' + k);
      if (!el) continue;
      el.value = Math.round(Audio.vol(k) * 100);
      el.oninput = () => { Audio.setVol(k, el.value / 100); if (k === 'sfx' || k === 'master') sfxT('pickup', undefined, undefined, 150); };
    }
  }
  $m('mRadio').onclick = () => { Radio.toggle(); refreshMenu(); };
  $m('mTod').onclick = () => { todMode = { day: 'night', night: 'cycle', cycle: 'day' }[todMode] || 'day'; store.set('cc_tod', todMode); refreshMenu(); };
  $m('mFull').onclick = () => {
    const de = document.documentElement;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else { const r = (de.requestFullscreen || de.webkitRequestFullscreen).call(de); if (r && r.catch) r.catch(() => {}); }
    } catch {}
    setTimeout(refreshMenu, 300);
  };
  $m('mRestart').onclick = () => {
    if (performance.now() < restartArm) { restartArm = 0; act('r'); setMenu(false); }
    else { restartArm = performance.now() + 3000; refreshMenu(); }
  };
  $m('mClose').onclick = () => setMenu(false);
  $m('mPolice').onclick = () => { act('c'); setTimeout(refreshMenu, 300); };
  $m('mQuit').onclick = () => { leaveGame(); setTimeout(() => { try { location.reload(); } catch {} }, 120); };
  menuEl.addEventListener('click', (e) => { if (e.target === menuEl) setMenu(false); });
  // in a fist fight: four attack buttons (light / heavy punch, light / heavy kick)
  const FKEYS = { KeyA: S.Fight.LP, ControlLeft: S.Fight.LP, ControlRight: S.Fight.LP, KeyS: S.Fight.HP, KeyZ: S.Fight.LK, Space: S.Fight.LK, KeyX: S.Fight.HK, KeyD: S.Fight.HP, KeyC: S.Fight.HK };
  if (IS_MAC) { FKEYS.AltLeft = S.Fight.LP; FKEYS.AltRight = S.Fight.LP; }
  const inFight = () => !!(fight.pred && !fight.pred.done);
  // street brawls (three or more fighting it out top-down in a chalk ring): parsed from each snapshot's g.br
  let brawlMap = new Map(), brawlMember = new Map(), myBrawl = null;
  const BST = { OK: 0, HURT: 1, DOWN: 2, BLOCK: 3, UP: 4, KO: 5, FLY: 6 };
  const bFree = (st) => st === BST.OK || st === BST.BLOCK;
  function brawlParse(g) {
    brawlMap = new Map(); brawlMember = new Map(); myBrawl = null;
    for (const r of (g && g.br) || []) {
      const b = { id: r[0], x: r[1], y: r[2], r: r[3], car: r[4], left: r[5], m: new Map() };
      for (let i = 6; i + 2 < r.length + 1; i += 3) { const m = { hp: r[i + 1], st: r[i + 2], b }; b.m.set(r[i], m); brawlMember.set(r[i], m); }
      brawlMap.set(b.id, b);
      if (b.m.has(myId)) myBrawl = b;
    }
  }
  const inBrawl = () => !!(myBrawl && me && me.al);
  // for the error log: what the player was doing when something broke
  var errCtx = () => {
    const bits = [];
    if (!me) bits.push('on the start page');
    else if (!me.al) bits.push('dead, waiting to respawn');
    else if (inFight()) bits.push('in a one-on-one fight');
    else if (myBrawl) bits.push('in a street brawl (' + myBrawl.m.size + ' fighters)');
    else if (pred.mode === 'car') { const C = S.CARS[pred.c.t]; bits.push('driving ' + (C && C.name ? C.name : 'vehicle ' + pred.c.t)); }
    else if (pred.mode === 'ped') bits.push('on foot');
    try { if (me && myRace()) bits.push('in a race'); } catch {}
    try { bits.push((game && game.P ? game.P.length : '?') + ' people in the city'); } catch {}
    bits.push(innerWidth + '×' + innerHeight + (matchMedia('(pointer:coarse)').matches ? ' touch' : ''));
    bits.push(Math.round(performance.now() / 60000) + ' min since the page opened');
    return bits.join(' · ');
  };
  const myBrawlSt = () => { const m = myBrawl && myBrawl.m.get(myId); return m ? m.st : -1; };
  // your own person in a brawl, predicted the way the game moves them: 8-way, slower while blocking, kept in the ring
  function brawlStep(p, k) {
    const st = myBrawlSt();
    if (!bFree(st)) return;
    const x0 = p.x, y0 = p.y;
    S.stepPed(map, p, k & (15 | K.ABS), DT); // (your usual controls: turn-and-go, or 8-way)
    if (k & K.BLOCK) { p.x = x0 + (p.x - x0) * 0.4; p.y = y0 + (p.y - y0) * 0.4; }
    if (!(k & 15)) { // standing still: turn toward whoever is nearest (the game does the same)
      let best = null, bd = 95;
      for (const pid of myBrawl.m.keys()) { if (pid === myId || myBrawl.m.get(pid).st === BST.KO) continue; const an = pedAnim.get(Math.abs(pid)); if (!an) continue; const d = Math.hypot(an.x - p.x, an.y - p.y); if (d < bd) { bd = d; best = an; } }
      if (best) { const d = S.angDiff(Math.atan2(best.y - p.y, best.x - p.x), p.a); p.a = S.wrapA(p.a + Math.sign(d) * Math.min(Math.abs(d), 8 * DT)); }
    }
    const b = myBrawl, dx = p.x - b.x, dy = p.y - b.y, dd = Math.hypot(dx, dy);
    if (dd > b.r - 8) { p.x = b.x + (dx / dd) * (b.r - 8); p.y = b.y + (dy / dd) * (b.r - 8); }
  }
  function readKeys() {
    if (document.activeElement === chatEl || menuOpen || offer) return 0; // (paused while a fist fight is on offer)
    if (inFight()) {
      let k = 0;
      for (const c of keys) { if (FKEYS[c]) k |= FKEYS[c]; else if (KEYMAP[c]) k |= KEYMAP[c] & 15; }
      for (const c of touchKeys) k |= c;
      return k | (stickKeys() & 15);
    }
    if (inBrawl()) {
      // the fight buttons, as brawl moves: light punch = punch, light kick = kick, heavy punch = block, heavy kick = grab
      let k = 0;
      for (const c of keys) { if (FKEYS[c]) k |= FKEYS[c]; else if (KEYMAP[c]) k |= KEYMAP[c] & 15; }
      for (const c of touchKeys) k |= c;
      k |= stickKeys() & 15;
      const F = S.Fight;
      return (k & 15) | (ctrlMode === 'abs' ? K.ABS : 0) | (k & F.LP ? K.FIRE : 0) | (k & F.LK ? K.HAND : 0) | (k & F.HP ? K.BLOCK : 0) | (k & F.HK ? K.GRAB : 0);
    }
    { const rc = game && game.rc; if (rc && rc[0] === 1 && myRace() && pred.mode === 'ped') return 0; } // on the start line: wait for GO
    let k = 0;
    for (const c of keys) if (KEYMAP[c]) k |= KEYMAP[c];
    for (const c of touchKeys) k |= c;
    k |= stickKeys();
    if (ctrlMode === 'abs') k |= K.ABS;
    return k;
  }
  function setupTouch() {
    const el = document.getElementById('touch');
    el.style.display = 'block';
    const mk = (label, style, onDown, onUp, fightBtn) => {
      const b = document.createElement('div');
      (fightBtn ? fightBtns : streetBtns).push(b);
      if (fightBtn) b.style.display = 'none';
      b.className = 'b'; b.textContent = label; Object.assign(b.style, style);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('on'); b.setPointerCapture(e.pointerId); onDown(); });
      const up = () => { b.classList.remove('on'); onUp && onUp(); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      el.appendChild(b);
      return b;
    };
    const hold = (bit) => [() => touchKeys.add(bit), () => touchKeys.delete(bit)];
    // the joystick: a ring with a knob, bottom left; drag the knob the way you want to go
    {
      const R = 62, base = document.createElement('div'), knob = document.createElement('div');
      Object.assign(base.style, { position: 'absolute', left: '22px', bottom: '22px', width: R * 2 + 'px', height: R * 2 + 'px', borderRadius: '50%', background: 'rgba(255,255,255,.10)', border: '2px solid rgba(255,255,255,.35)', pointerEvents: 'auto', touchAction: 'none' });
      Object.assign(knob.style, { position: 'absolute', left: R - 28 + 'px', top: R - 28 + 'px', width: '56px', height: '56px', borderRadius: '50%', background: 'rgba(255,255,255,.35)', border: '2px solid rgba(255,255,255,.6)', pointerEvents: 'none' });
      base.appendChild(knob); el.appendChild(base);
      let pid = null;
      const move = (e) => {
        const r = base.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy), l = Math.min(d, R);
        stick.on = true; stick.a = Math.atan2(dy, dx); stick.m = Math.min(1, d / R);
        knob.style.transform = `translate(${d ? (dx / d) * l : 0}px, ${d ? (dy / d) * l : 0}px)`;
        knob.style.background = stick.m > 0.28 ? 'rgba(255,210,31,.55)' : 'rgba(255,255,255,.35)';
      };
      base.addEventListener('pointerdown', (e) => { e.preventDefault(); pid = e.pointerId; base.setPointerCapture(pid); move(e); });
      base.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e); });
      const end = (e) => { if (e.pointerId !== pid) return; pid = null; stick.on = false; stick.m = 0; knob.style.transform = ''; knob.style.background = 'rgba(255,255,255,.35)'; };
      base.addEventListener('pointerup', end); base.addEventListener('pointercancel', end);
    }
    mk('FIRE', { right: '20px', bottom: '40px', width: '84px', height: '84px' }, ...hold(K.FIRE));
    mk('CAR', { right: '118px', bottom: '22px' }, () => act('e'));
    mk('MENU', { right: '16px', top: '196px', width: '64px', height: '34px', borderRadius: '8px', fontSize: '13px' }, () => setMenu(!menuOpen));
    mk('JUMP', { right: '118px', bottom: '96px' }, ...hold(K.HAND));
    mk('Z', { right: '30px', bottom: '140px', width: '48px', height: '48px' }, () => act('p'));
    mk('X', { right: '88px', bottom: '170px', width: '48px', height: '48px' }, () => act('n'));
    mk('HORN', { right: '146px', bottom: '170px', width: '56px', height: '48px', fontSize: '12px' }, () => act('h'));
    mk('TURRET', { right: '208px', bottom: '22px', width: '64px', height: '48px', borderRadius: '10px', fontSize: '12px' }, ...hold(K.TUR)); // hold: the stick aims the tank's or boat's gun
    // in a fist fight: four attack buttons instead (punches on top, kicks below, light on the left)
    const fb = { width: '72px', height: '72px', fontSize: '15px' };
    mk('LP', { right: '104px', bottom: '118px', ...fb }, ...hold(S.Fight.LP), true);
    mk('HP', { right: '22px', bottom: '140px', ...fb, background: 'rgba(230,60,40,.35)' }, ...hold(S.Fight.HP), true);
    mk('LK', { right: '120px', bottom: '30px', ...fb }, ...hold(S.Fight.LK), true);
    mk('HK', { right: '30px', bottom: '50px', ...fb, background: 'rgba(230,60,40,.35)' }, ...hold(S.Fight.HK), true);
  }
  const fightBtns = [], streetBtns = [];
  let touchFightMode = false;
  function setTouchFight(on) {
    if (on === touchFightMode) return;
    touchFightMode = on; touchKeys.clear();
    for (const b of fightBtns) b.style.display = on ? '' : 'none';
    for (const b of streetBtns) if (!fightBtns.includes(b)) b.style.display = on ? 'none' : '';
  }

  // ================================================================ world textures
  const CH = 8, CS = CH * TILE;
  const chunks = new Map();
  let frameNo = 0;
  const ROOFS = [
    { roof: '#8d8d86', wall: '#6f6e68' }, { roof: '#b39b72', wall: '#8e7753' }, { roof: '#6e4438', wall: '#8a3f2e' }, { roof: '#4a5058', wall: '#3a3f46' },
    { roof: '#5e8a86', wall: '#46706c' }, { roof: '#c9c6bd', wall: '#a9a59a' }, { roof: '#5b574f', wall: '#6a5a4a' }, { roof: '#8a5a32', wall: '#5f5d58' },
  ];
  let tallList = [];
  function initWorld() {
    chunks.clear();
    tallList = [];
    for (const b of map.buildings) tallList.push({ kind: 'b', z: b.lv * S.LEVEL, b });
    // chop shop doors, drawn on the building's wall when that wall faces the camera
    for (const sh of map.shops || []) {
      const b = map.buildings[sh.b];
      if (!b) continue;
      const x0 = b.x * TILE, y0 = b.y * TILE, x1 = (b.x + b.w) * TILE, y1 = (b.y + b.h) * TILE;
      b.shop = Object.assign(sh, { vis: (c) => (sh.wx > 0 ? c.x < x0 : sh.wx < 0 ? c.x > x1 : sh.wy > 0 ? c.y < y0 : c.y > y1) });
    }
    for (const t of map.trees) tallList.push({ kind: 't', z: 34, t });
    map.lamps = [];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
      if (S.tile(map, x, y) !== T.PAVE) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (S.tile(map, x + dx, y + dy) !== T.ROAD || ((dx ? y : x) % 3) !== 0) continue;
        const lx = (x + 0.5) * TILE + dx * 25, ly = (y + 0.5) * TILE + dy * 25;
        const l = { x: lx, y: ly, hx: lx + dx * 20, hy: ly + dy * 20, bad: S.hash(x, y, 9) < 0.07, ph: S.hash(x, y, 3) * 50 };
        map.lamps.push(l); tallList.push({ kind: 'l', z: 30, l });
        break;
      }
    }
    tallList.sort((a, b) => a.z - b.z);
    if (/[?&]debug\b/.test(location.search)) window.__cc = { get pred() { return pred; }, get snap() { return snaps[snaps.length - 1]; }, get lowMsg() { return lowMsg; }, get audio() { return Audio; }, get radio() { return Radio; }, get map() { return map; }, get fight() { return fight; }, get chunks() { return chunks; }, get off() { return off; }, get snaps() { return snaps; }, get interp() { return INTERP; }, set interp(v) { INTERP = v; }, get clockOff() { return clockOff; }, get viewLag() { return viewLag; }, get parts() { return parts; }, carSprite: (t, col) => carSprite(t, col, false), drawPed, pedLook, drawParts };
  }
  function shade(hex, amt) {
    let r, g, b;
    if (hex[0] === '#') { const n = parseInt(hex.slice(1), 16); r = n >> 16; g = (n >> 8) & 255; b = n & 255; }
    else [r, g, b] = (hex.match(/[\d.]+/g) || [0, 0, 0]).map(Number); // an rgb(...) from shade itself
    if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }
  const tl = (x, y) => S.tile(map, x, y);
  // ---------------------------------------------------------------- water
  // how far each water tile is from land (in tiles, capped), worked out once per map
  let wDepth = null, wDepthMap = null;
  function depthField() {
    if (wDepthMap === map && wDepth) return wDepth;
    const W = map.w, H = map.h, d = new Float32Array(W * H).fill(99), q = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (map.tiles[y * W + x] !== T.WATER) { d[y * W + x] = -0.5; q.push(y * W + x); }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % W, y = (c / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx, v = Math.max(0.5, d[c] + (dx && dy ? 1.41 : 1));
        if (v < d[n] && v < 9) { d[n] = v; q.push(n); }
      }
    }
    for (let i = 0; i < d.length; i++) if (d[i] > 9) d[i] = 9;
    wDepth = d; wDepthMap = map; return d;
  }
  // depth at a point (in tiles), blended between the tile centres around it
  function depthAt(fx, fy) {
    const d = depthField(), W = map.w, H = map.h;
    const x = fx - 0.5, y = fy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), u = x - x0, v = y - y0;
    const at = (a, b) => (a < 0 || b < 0 || a >= W || b >= H ? 9 : d[b * W + a]);
    return (at(x0, y0) * (1 - u) + at(x0 + 1, y0) * u) * (1 - v) + (at(x0, y0 + 1) * (1 - u) + at(x0 + 1, y0 + 1) * u) * v;
  }
  const WATER_RAMP = [[0, [70, 214, 236]], [0.9, [44, 166, 222]], [2.2, [30, 116, 196]], [4, [22, 78, 156]], [6.5, [15, 50, 112]], [9, [11, 34, 82]]];
  function waterRGB(d) {
    if (d <= 0) return WATER_RAMP[0][1];
    for (let i = 1; i < WATER_RAMP.length; i++) if (d <= WATER_RAMP[i][0]) {
      const [d0, c0] = WATER_RAMP[i - 1], [d1, c1] = WATER_RAMP[i], f = (d - d0) / (d1 - d0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
    return WATER_RAMP[WATER_RAMP.length - 1][1];
  }
  const waterCol = (d) => { const c = waterRGB(d); return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; };
  // the caustic pattern: the bright wavy net of light on water, one tileable 256 px square, made once
  let causticPat = null;
  function caustics() {
    if (causticPat) return causticPat;
    const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), img = g.createImageData(N, N), R2 = S.rng(77), pts = [];
    for (let i = 0; i < 16; i++) pts.push([R2() * N, R2() * N]);
    const TAU = Math.PI * 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      // wobble the coordinates (with waves that repeat exactly across the square) so the cell borders curve
      const wx = x + 9 * Math.sin(TAU * (2 * y / N) + 1.3) + 5 * Math.sin(TAU * (3 * (x + y) / N));
      const wy = y + 9 * Math.sin(TAU * (2 * x / N) + 0.4) + 5 * Math.sin(TAU * (3 * (x - y) / N) + 2);
      let f1 = 1e9, f2 = 1e9;
      for (const [px, py] of pts) {
        let dx = Math.abs(wx - px) % N, dy = Math.abs(wy - py) % N; if (dx > N / 2) dx = N - dx; if (dy > N / 2) dy = N - dy; // wraps round: tiles seamlessly
        const dd = dx * dx + dy * dy;
        if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
      }
      // soft, rounded light: bright where two cells meet, fading gently into each cell, rounder near the corners
      const r = Math.sqrt(f1) / Math.sqrt(f2), a = Math.pow(r, 3.2);
      const o = (y * N + x) * 4; img.data[o] = 200; img.data[o + 1] = 245; img.data[o + 2] = 255; img.data[o + 3] = (a * 255) | 0;
    }
    g.putImageData(img, 0, 0);
    // blur it (drawn 3x3 so the blur wraps round the edges too) for a diffused glow rather than hard lines
    const big = document.createElement('canvas'); big.width = big.height = N * 3;
    const bg = big.getContext('2d');
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) bg.drawImage(c, i * N, j * N);
    g.clearRect(0, 0, N, N); g.filter = 'blur(3px)'; g.drawImage(big, -N, -N); g.filter = 'none';
    causticPat = c; return c;
  }
  // per ground chunk: where the water is, brighter in the shallows (the caustics show most there), at quarter size
  function waterMask(ch, cx, cy) {
    if (ch.wm !== undefined) return ch.wm;
    let any = false;
    for (let j = 0; j < CH && !any; j++) for (let i = 0; i < CH && !any; i++) if (S.tile(map, cx * CH + i, cy * CH + j) === T.WATER) any = true;
    if (!any) return (ch.wm = null);
    const M = CS / 4, c = document.createElement('canvas'); c.width = c.height = M;
    const g = c.getContext('2d');
    const img = g.createImageData(M, M), D = img.data;
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const fx = cx * CH + (x + 0.5) / 16, fy = cy * CH + (y + 0.5) / 16;
      if (S.tile(map, Math.floor(fx), Math.floor(fy)) !== T.WATER) continue;
      const d = depthAt(fx, fy), o = (y * M + x) * 4;
      D[o] = D[o + 1] = D[o + 2] = 255; D[o + 3] = (255 * (0.32 + 0.68 * Math.max(0, 1 - d / 5))) | 0;
    }
    g.putImageData(img, 0, 0);
    return (ch.wm = c);
  }
  // each frame, over the water on screen: two layers of caustics drifting different ways, then the sparkles
  const scratch = document.createElement('canvas'); scratch.width = scratch.height = CS / 2;
  const sg = scratch.getContext('2d');
  const sparkleTiles = new Map(); let cauPat = null;
  function drawWaterFx(c0, c1, r0, r1, t) {
    if (GFX === 'fast') return;
    const pat = caustics();
    if (!cauPat) cauPat = sg.createPattern(pat, 'repeat');
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const ch = getChunk(cx, cy), wm = waterMask(ch, cx, cy);
      if (!wm) continue;
      const N = CS / 2;
      sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, N, N);
      for (const [vx, vy, sc, al] of [[9, 5, 1, 0.55], [-6, 8, 0.75, 0.4]]) {
        sg.save(); sg.globalAlpha = al; sg.scale(sc, sc);
        const ox = ((t * vx + cx * N) / sc) % 256, oy = ((t * vy + cy * N) / sc) % 256;
        sg.translate(-ox, -oy);
        sg.fillStyle = cauPat; sg.fillRect(0, 0, N / sc + 512, N / sc + 512);
        sg.restore();
      }
      sg.globalAlpha = 1; sg.globalCompositeOperation = 'destination-in'; sg.drawImage(wm, 0, 0, N, N);
      const op = ctx.globalCompositeOperation; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.4 * (1 - 0.6 * sun.night);
      ctx.drawImage(scratch, cx * CS, cy * CS, CS, CS);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = op;
      // sparkles: tiny glints that wink on and off, a few per water tile
      ctx.fillStyle = '#fff';
      const ck = cy * 4096 + cx;
      let wt = sparkleTiles.get(ck);
      if (!wt) { wt = []; for (let j = 0; j < CH; j++) for (let i = 0; i < CH; i++) if (S.tile(map, cx * CH + i, cy * CH + j) === T.WATER) wt.push(cx * CH + i, cy * CH + j); sparkleTiles.set(ck, wt); }
      for (let q = 0; q < wt.length; q += 2) {
        const tx = wt[q], ty = wt[q + 1];
        for (let n = 0; n < 2; n++) {
          const hsh = ((tx * 73856093) ^ (ty * 19349663) ^ (n * 83492791)) >>> 0, ph = (hsh % 1000) / 1000;
          const w = Math.sin((t * (0.7 + ph)) + ph * 40);
          if (w < 0.93) continue;
          const k = (w - 0.93) / 0.07, x = tx * TILE + (hsh % 61), y = ty * TILE + ((hsh >> 8) % 61);
          ctx.globalAlpha = k * (1 - 0.7 * sun.night); ctx.fillRect(x - 2 * k, y - 0.6, 4 * k, 1.2); ctx.fillRect(x - 0.6, y - 1.5 * k, 1.2, 3 * k);
        }
      }
      ctx.globalAlpha = 1;
    }
  }
  function drawTile(g, tx, ty, px, py) {
    const t = tl(tx, ty);
    const R = S.rng(tx * 7919 + ty * 104729 + map.seed);
    const speck = (n, cols, sz = 2) => { for (let i = 0; i < n; i++) { g.fillStyle = cols[(R() * cols.length) | 0]; g.fillRect(px + ((R() * 64) | 0), py + ((R() * 64) | 0), sz, sz); } };
    if (t === T.ROAD) {
      g.fillStyle = '#3b3c40'; g.fillRect(px, py, 64, 64);
      speck(80, ['rgba(0,0,0,.2)', 'rgba(255,255,255,.07)', 'rgba(0,0,0,.12)']);
      if (R() < 0.18) { g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(px + ((R() * 36) | 0), py + ((R() * 36) | 0), 12 + ((R() * 16) | 0), 8 + ((R() * 12) | 0)); }
      const vc = map.roadCols.has(tx), hr = map.roadRows.has(ty);
      // no zebra crossing onto a bridge deck (the crossing road is water on both sides there)
      const wet = (x, y) => tl(x - 1, y) === T.WATER || tl(x + 1, y) === T.WATER || tl(x, y - 1) === T.WATER || tl(x, y + 1) === T.WATER;
      g.fillStyle = '#d6b22e';
      if (vc && !hr) {
        const x = map.roadCols.has(tx + 1) ? px + 61 : px;
        g.fillRect(x, py + 14, 3, 30);
        g.fillStyle = '#e9e9e2';
        if (map.roadRows.has(ty - 1) && !wet(tx, ty - 1)) for (let i = 0; i < 6; i++) g.fillRect(px + 3 + i * 10, py + 3, 6, 24);
        if (map.roadRows.has(ty + 1) && !wet(tx, ty + 1)) for (let i = 0; i < 6; i++) g.fillRect(px + 3 + i * 10, py + 37, 6, 24);
      } else if (hr && !vc) {
        const y = map.roadRows.has(ty + 1) ? py + 61 : py;
        g.fillRect(px + 14, y, 30, 3);
        g.fillStyle = '#e9e9e2';
        if (map.roadCols.has(tx - 1) && !wet(tx - 1, ty)) for (let i = 0; i < 6; i++) g.fillRect(px + 3, py + 3 + i * 10, 24, 6);
        if (map.roadCols.has(tx + 1) && !wet(tx + 1, ty)) for (let i = 0; i < 6; i++) g.fillRect(px + 37, py + 3 + i * 10, 24, 6);
      } else {
        g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(px, py, 64, 64);
      }
      // river jump ramp: a raised wedge with chevrons pointing at the water
      const rd = map.rampAt && map.rampAt.get(ty * map.w + tx);
      if (rd !== undefined) {
        g.save(); g.translate(px + 32, py + 32); g.rotate([0, Math.PI / 2, Math.PI, -Math.PI / 2][rd]);
        const gr = g.createLinearGradient(-30, 0, 30, 0); gr.addColorStop(0, '#5d5f63'); gr.addColorStop(1, '#a9abae');
        g.fillStyle = '#000'; g.fillRect(-30, -27, 60, 54);
        g.fillStyle = gr; g.fillRect(-28, -25, 56, 50);
        g.fillStyle = '#ffd21f';
        for (let i = 0; i < 3; i++) { const cx0 = -18 + i * 15; g.beginPath(); g.moveTo(cx0, -16); g.lineTo(cx0 + 9, 0); g.lineTo(cx0, 16); g.lineTo(cx0 - 5, 16); g.lineTo(cx0 + 4, 0); g.lineTo(cx0 - 5, -16); g.closePath(); g.fill(); }
        g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(28, -27, 4, 54);
        g.restore();
      }
      // bridge deck: railings where the road meets water
      const nb = [tl(tx, ty - 1), tl(tx + 1, ty), tl(tx, ty + 1), tl(tx - 1, ty)];
      if (nb.includes(T.WATER)) {
        const vert = nb[1] === T.WATER || nb[3] === T.WATER; // water left/right: traffic runs north-south
        if (vert && vc && hr) { g.fillStyle = '#d6b22e'; g.fillRect(map.roadCols.has(tx + 1) ? px + 61 : px, py + 14, 3, 30); }
        else if (!vert && vc && hr) { g.fillStyle = '#d6b22e'; g.fillRect(px + 14, map.roadRows.has(ty + 1) ? py + 61 : py, 30, 3); }
        nb.forEach((nt, sd) => {
          if (nt !== T.WATER) return;
          const rect = (o, w, col) => {
            g.fillStyle = col;
            if (sd === 0) g.fillRect(px, py + o, 64, w); else if (sd === 1) g.fillRect(px + 64 - o - w, py, w, 64);
            else if (sd === 2) g.fillRect(px, py + 64 - o - w, 64, w); else g.fillRect(px + o, py, w, 64);
          };
          rect(0, 9, '#9a978c'); rect(0, 2, '#5d5b54'); rect(7, 2, '#cfccc0'); rect(9, 3, 'rgba(0,0,0,.22)');
          g.fillStyle = '#6e6b62';
          for (let i = 4; i < 64; i += 15) {
            if (sd === 0) g.fillRect(px + i, py + 1, 4, 7); else if (sd === 2) g.fillRect(px + i, py + 56, 4, 7);
            else if (sd === 1) g.fillRect(px + 56, py + i, 7, 4); else g.fillRect(px + 1, py + i, 7, 4);
          }
        });
      }
    } else if (t === T.PAVE) {
      g.fillStyle = '#76766f'; g.fillRect(px, py, 64, 64);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const v = 138 + ((R() * 14) | 0);
        g.fillStyle = `rgb(${v},${v},${v - 6})`;
        g.fillRect(px + i * 16 + 1, py + j * 16 + 1, 15, 15);
      }
      speck(30, ['rgba(0,0,0,.12)', 'rgba(255,255,255,.08)']);
      if (R() < 0.2) { g.fillStyle = 'rgba(0,0,0,.25)'; let x = px + R() * 64, y = py + R() * 64; for (let i = 0; i < 8; i++) { g.fillRect(x | 0, y | 0, 1, 1); x += R() * 3 - 1; y += R() * 3 - 1; } }
      const n = [tl(tx, ty - 1), tl(tx + 1, ty), tl(tx, ty + 1), tl(tx - 1, ty)];
      const edge = (side, w, col) => {
        g.fillStyle = col;
        if (side === 0) g.fillRect(px, py, 64, w); else if (side === 1) g.fillRect(px + 64 - w, py, w, 64);
        else if (side === 2) g.fillRect(px, py + 64 - w, 64, w); else g.fillRect(px, py, w, 64);
      };
      n.forEach((nt, s) => {
        if (nt === T.ROAD) { edge(s, 5, '#c9c7bd'); edge(s, 1, '#5e5e58'); }
        else if (nt === T.WATER) { edge(s, 6, '#5a5248'); edge(s, 2, '#3a332b'); }
        else if (nt === T.BUILD) edge(s, 12, 'rgba(0,0,0,.28)');
      });
    } else if (t === T.GRASS) {
      g.fillStyle = '#4b7d33'; g.fillRect(px, py, 64, 64);
      speck(140, ['#5a9140', '#3d6a29', '#558a3b', '#44752e']);
      if (R() < 0.3) speck(5, ['#e8d84a', '#f0f0f0', '#d65f8a'], 2);
      [tl(tx, ty - 1), tl(tx + 1, ty), tl(tx, ty + 1), tl(tx - 1, ty)].forEach((nt, s) => {
        if (nt !== T.GRASS) { g.fillStyle = '#35602a'; if (s === 0) g.fillRect(px, py, 64, 3); else if (s === 1) g.fillRect(px + 61, py, 3, 64); else if (s === 2) g.fillRect(px, py + 61, 64, 3); else g.fillRect(px, py, 3, 64); }
      });
    } else if (t === T.WATER) {
      // water by depth: bright turquoise over the shallows by the shore, down to deep navy out in the open,
      // smoothly (8 px steps, blended between tile centres)
      // painted pixel by pixel so the gradient is smooth, with a slow wave through it so it isn't too even
      const img = g.createImageData(64, 64), D = img.data;
      for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
        const wx = tx * 64 + i, wy = ty * 64 + j;
        const d = depthAt(wx / 64, wy / 64) + 0.22 * Math.sin(wx * 0.021 + Math.sin(wy * 0.017) * 2) * Math.sin(wy * 0.019 + 1.7);
        const c = waterRGB(d), o = (j * 64 + i) * 4;
        D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
      }
      g.putImageData(img, px, py);
      if (map.rail && map.rail[ty * map.w + tx]) {
        // shadow of the bridge deck on the river
        const nb = [tl(tx, ty - 1), tl(tx + 1, ty), tl(tx, ty + 1), tl(tx - 1, ty)];
        g.fillStyle = 'rgba(5,20,40,.45)';
        const deck = (x, y) => (map.bridges || []).some((b) => x >= b.x && x < b.x + 2 && y >= b.y && y < b.y + 2);
        if (deck(tx, ty - 1)) g.fillRect(px, py, 64, 18); if (deck(tx, ty + 1)) g.fillRect(px, py + 46, 64, 18);
        if (deck(tx + 1, ty)) g.fillRect(px + 46, py, 18, 64); if (deck(tx - 1, ty)) g.fillRect(px, py, 18, 64);
      }
      // foam where the water meets land: a bright edge fading out over a few pixels
      [tl(tx, ty - 1), tl(tx + 1, ty), tl(tx, ty + 1), tl(tx - 1, ty)].forEach((nt, s) => {
        if (nt === T.WATER) return;
        const F = 14, x0 = s === 1 ? px + 64 : s === 3 ? px : 0, y0 = s === 0 ? py : s === 2 ? py + 64 : 0;
        const gr = s === 0 || s === 2 ? g.createLinearGradient(0, y0, 0, y0 + (s === 0 ? F : -F)) : g.createLinearGradient(x0, 0, x0 + (s === 3 ? F : -F), 0);
        gr.addColorStop(0, 'rgba(235,250,255,.75)'); gr.addColorStop(0.25, 'rgba(220,245,255,.35)'); gr.addColorStop(1, 'rgba(200,240,255,0)');
        g.fillStyle = gr;
        if (s === 0) g.fillRect(px, py, 64, F); else if (s === 2) g.fillRect(px, py + 64 - F, 64, F); else if (s === 1) g.fillRect(px + 64 - F, py, F, 64); else g.fillRect(px, py, F, 64);
        // a few blobs of foam along the edge
        g.fillStyle = 'rgba(240,252,255,.55)';
        for (let i = 0; i < 4; i++) { const u = R() * 64, w2 = 1 + R() * 2.5, o = R() * 5; if (s === 0 || s === 2) { g.beginPath(); g.arc(px + u, s === 0 ? py + o : py + 64 - o, w2, 0, 7); g.fill(); } else { g.beginPath(); g.arc(s === 3 ? px + o : px + 64 - o, py + u, w2, 0, 7); g.fill(); } }
      });
    } else {
      g.fillStyle = '#2a2a2a'; g.fillRect(px, py, 64, 64);
    }
  }
  // a trampoline: black frame, blue mat, springs all round
  function drawTramp(g, x, y) {
    g.save(); g.translate(x, y);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(4, 4, 22, 21, 0, 0, 7); g.fill();
    g.fillStyle = '#16171b'; g.beginPath(); g.arc(0, 0, 21, 0, 7); g.fill();
    g.strokeStyle = '#9aa0a8'; g.lineWidth = 1.2;
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; g.beginPath(); g.moveTo(Math.cos(a) * 14.5, Math.sin(a) * 14.5); g.lineTo(Math.cos(a) * 19.5, Math.sin(a) * 19.5); g.stroke(); }
    const gr = g.createRadialGradient(-3, -3, 2, 0, 0, 14); gr.addColorStop(0, '#3d6fd8'); gr.addColorStop(1, '#1d3c8a');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 14, 0, 7); g.fill();
    g.strokeStyle = '#ffd21f'; g.lineWidth = 1.5; g.beginPath(); g.arc(0, 0, 9, 0, 7); g.stroke();
    g.restore();
  }
  // a chop shop's forecourt: oil-stained concrete and paint overspray running up to the door
  function drawShopApron(g, x, y, sh) {
    g.save(); g.translate(x, y); g.rotate(Math.atan2(sh.wy, sh.wx));
    // local frame: +x points into the building, the wall is at x = 18
    g.fillStyle = '#5d5c58'; g.fillRect(-30, -26, 48, 52);
    g.fillStyle = 'rgba(0,0,0,.18)'; for (let i = 0; i < 4; i++) g.fillRect(-30 + i * 12, -26, 1, 52);
    const R = S.rng(Math.round(sh.x * 7 + sh.y));
    for (let i = 0; i < 7; i++) { g.fillStyle = `rgba(10,10,12,${0.18 + R() * 0.25})`; g.beginPath(); g.ellipse(-20 + R() * 34, -18 + R() * 36, 3 + R() * 7, 2 + R() * 5, R() * 3, 0, 7); g.fill(); }
    for (const col of ['255,60,170', '40,220,230', '255,210,40']) { g.fillStyle = `rgba(${col},.22)`; g.beginPath(); g.ellipse(8 + R() * 8, -20 + R() * 40, 4 + R() * 5, 3 + R() * 4, R() * 3, 0, 7); g.fill(); }
    g.fillStyle = '#2a2a2c'; g.fillRect(15, -24, 3, 48); // the door's threshold
    g.restore();
  }
  function buildChunk(cx, cy) {
    const c = document.createElement('canvas');
    c.width = CS; c.height = CS;
    const g = c.getContext('2d');
    for (let j = 0; j < CH; j++) for (let i = 0; i < CH; i++) drawTile(g, cx * CH + i, cy * CH + j, i * TILE, j * TILE);
    for (const tr of map.tramps || []) { const x = tr.x - cx * CS, y = tr.y - cy * CS; if (x > -30 && y > -30 && x < CS + 30 && y < CS + 30) drawTramp(g, x, y); }
    for (const sh of map.shops || []) { const x = sh.x - cx * CS, y = sh.y - cy * CS; if (x > -60 && y > -60 && x < CS + 60 && y < CS + 60) drawShopApron(g, x, y, sh); }
    // parking lots
    for (const l of map.lots) {
      const lx = l.x * TILE - cx * CS, ly = l.y * TILE - cy * CS, lw = l.w * TILE, lh = l.h * TILE;
      if (lx > CS || ly > CS || lx + lw < 0 || ly + lh < 0) continue;
      g.fillStyle = '#4a4a4e'; g.fillRect(lx + 4, ly + 4, lw - 8, lh - 8);
      g.fillStyle = '#d8d8d0';
      for (let x = 0; x <= lw - 8; x += 32) { g.fillRect(lx + 4 + x, ly + 4, 2, 44); if (lh > 128) g.fillRect(lx + 4 + x, ly + lh - 48, 2, 44); }
    }
    return { cv: c, g, used: frameNo };
  }
  function getChunk(cx, cy) {
    const key = cy * 1000 + cx;
    let c = chunks.get(key);
    if (!c) {
      c = buildChunk(cx, cy);
      chunks.set(key, c);
      if (chunks.size > 70) {
        let old = null, ok = 0;
        for (const [k2, v] of chunks) if (!old || v.used < old.used) { old = v; ok = k2; }
        chunks.delete(ok);
      }
    }
    c.used = frameNo;
    return c;
  }
  // stamp something permanent onto the ground (blood, skid marks, scorch)
  // Marks on the ground (skid marks, blood, scorch marks, bodies) go on see-through layers over each ground chunk,
  // a new layer every few seconds. A layer stays for 30 seconds and then fades away over 15.
  const MARK_KEEP = 30, MARK_FADE = 15, MARK_LAYER = 4, MARK_RES = 0.5;
  function stamp(x, y, r, fn) {
    const now = performance.now() / 1000;
    const c0 = Math.floor((x - r) / CS), c1 = Math.floor((x + r) / CS), r0 = Math.floor((y - r) / CS), r1 = Math.floor((y + r) / CS);
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const c = chunks.get(cy * 1000 + cx);
      if (!c) continue;
      if (!c.marks) c.marks = [];
      let m = c.marks[c.marks.length - 1];
      if (!m || now - m.t0 > MARK_LAYER) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = Math.ceil(CS * MARK_RES);
        m = { cv, g: cv.getContext('2d'), t0: now };
        c.marks.push(m);
      }
      m.g.save(); m.g.scale(MARK_RES, MARK_RES); m.g.translate(-cx * CS, -cy * CS); fn(m.g); m.g.restore();
    }
  }
  function drawMarks(c, x, y) {
    if (!c.marks || !c.marks.length) return;
    const now = performance.now() / 1000;
    while (c.marks.length && now - c.marks[0].t0 > MARK_KEEP + MARK_FADE) c.marks.shift();
    for (const m of c.marks) {
      const age = now - m.t0;
      ctx.globalAlpha = age < MARK_KEEP ? 1 : 1 - E.inOutCubic((age - MARK_KEEP) / MARK_FADE);
      ctx.drawImage(m.cv, x, y, CS + 0.6, CS + 0.6);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- roofs
  function roofCanvas(b) {
    if (b.rc) return b.rc;
    const w = (b.w * TILE) / 2, h = (b.h * TILE) / 2;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const R = S.rng(b.sd), pal = ROOFS[b.st];
    g.fillStyle = pal.roof; g.fillRect(0, 0, w, h);
    for (let i = 0; i < (w * h) / 14; i++) { g.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.07)'; g.fillRect((R() * w) | 0, (R() * h) | 0, 1, 1); }
    if (R() < 0.35) { g.fillStyle = 'rgba(0,0,0,.08)'; for (let x = 4; x < w - 4; x += 8) g.fillRect(x, 3, 1, h - 6); }
    g.fillStyle = shade(pal.roof, 0.28); g.fillRect(0, 0, w, 3); g.fillRect(0, 0, 3, h);
    g.fillStyle = shade(pal.roof, -0.3); g.fillRect(0, h - 3, w, 3); g.fillRect(w - 3, 0, 3, h);
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(3, 3, w - 6, 2); g.fillRect(3, 3, 2, h - 6);
    const n = 1 + Math.floor((w * h) / 1600);
    for (let i = 0; i < n; i++) {
      const r = R(), x = 8 + R() * Math.max(1, w - 30), y = 8 + R() * Math.max(1, h - 30);
      if (r < 0.4) { // AC unit
        g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x + 2, y + 2, 12, 9);
        g.fillStyle = '#b7babe'; g.fillRect(x, y, 12, 9);
        g.fillStyle = '#6d7175'; g.beginPath(); g.arc(x + 6, y + 4.5, 3, 0, 7); g.fill();
        g.fillStyle = '#d9dbde'; g.fillRect(x, y, 12, 1);
      } else if (r < 0.6) { // stair hut
        g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x + 3, y + 3, 16, 12);
        g.fillStyle = shade(pal.roof, -0.15); g.fillRect(x, y, 16, 12);
        g.fillStyle = shade(pal.roof, 0.15); g.fillRect(x, y, 16, 2);
      } else if (r < 0.78) { // skylight
        g.fillStyle = '#5d7d93'; g.fillRect(x, y, 14, 10);
        g.fillStyle = '#9ec3da'; g.fillRect(x + 1, y + 1, 12, 8);
        g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(x + 2, y + 6, 6, 1); g.fillRect(x + 5, y + 3, 6, 1);
      } else { // vents
        for (let k = 0; k < 3; k++) { g.fillStyle = '#3a3a3a'; g.beginPath(); g.arc(x + k * 6, y, 2.2, 0, 7); g.fill(); g.fillStyle = '#888'; g.fillRect(x + k * 6 - 1, y - 1, 1, 1); }
      }
    }
    if (b.pad || (b.lv >= 4 && w >= 80 && h >= 80 && R() < 0.6)) {
      // a proper landing pad: as big as the roof allows, so it still shows round a parked helicopter
      const cx = w / 2, cy = h / 2, r = Math.max(22, Math.min(w, h) / 2 - 3);
      g.fillStyle = '#2f3033'; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
      g.strokeStyle = '#f2cf3a'; g.lineWidth = Math.max(2.5, r * 0.1); g.beginPath(); g.arc(cx, cy, r * 0.86, 0, 7); g.stroke();
      g.strokeStyle = '#eee'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.arc(cx, cy, r * 0.66, 0, 7); g.stroke(); g.setLineDash([]);
      const hh = r * 1.0, hw = r * 0.62, st = Math.max(3, r * 0.14);
      g.fillStyle = '#f4f4f4'; g.fillRect(cx - hw / 2, cy - hh / 2, st, hh); g.fillRect(cx + hw / 2 - st, cy - hh / 2, st, hh); g.fillRect(cx - hw / 2, cy - st / 2, hw, st);
      // landing lights round the edge
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.fillStyle = '#7fe08a'; g.fillRect(cx + Math.cos(a) * r * 0.95 - 1, cy + Math.sin(a) * r * 0.95 - 1, 2, 2); }
    }
    b.rc = c;
    return c;
  }

  // ---------------------------------------------------------------- car sprites
  const carCache = new Map();
  function rr(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }
  // the tank (olive, tracks, turret and gun) and the speedboat (pointed hull, windscreen, outboard, minigun on the bow)
  // a boat passing under a bridge: copy the bridge deck from the ground chunk back over it
  function deckOver(x, y, r) {
    for (const b of map.bridges || []) {
      const x0 = b.x * TILE, y0 = b.y * TILE;
      if (x + r < x0 || x - r > x0 + 2 * TILE || y + r < y0 || y - r > y0 + 2 * TILE) continue;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const tx = b.x + i, ty = b.y + j, cx = Math.floor(tx / CH), cy = Math.floor(ty / CH);
        const ch = getChunk(cx, cy);
        ctx.drawImage(ch.cv, tx * TILE - cx * CS, ty * TILE - cy * CS, TILE, TILE, tx * TILE, ty * TILE, TILE, TILE);
      }
    }
  }
  // the tank's turret and the boat's bow minigun turn with Tab + Left/Right: drawn on top of the body at angle tur (car-relative)
  const turretSeen = new Map(); // where each tank and boat turret was last drawn: shots are moved onto its barrels
  // the two barrel ends of a boat's turret as drawn (car frame: turret at the bow, guns 15 px out, 2.6 px either side)
  function boatMuzzles(v) {
    const hl = S.CARS[S.BOAT].len / 2, ca = Math.cos(v.a), sa = Math.sin(v.a), ga = v.a + v.tur, cg = Math.cos(ga), sg = Math.sin(ga);
    const px = v.x + ca * (hl - 16), py = v.y + sa * (hl - 16);
    return [-2.6, 2.6].map((side) => [px + cg * 15 - sg * side, py + sg * 15 + cg * side]);
  }
  function drawTurret(g, C, tur, wreck) {
    const hl = C.len / 2;
    if (C.kind === 'tank') {
      const ol = wreck ? '#2c2926' : '#56602f', olD = wreck ? '#1d1b19' : '#3b4220', olL = wreck ? '#3a3632' : '#727d42';
      g.save(); g.translate(-2, 0); g.rotate(tur);
      g.fillStyle = olD; g.fillRect(6, -2.2, hl + 6, 4.4); g.fillStyle = '#1b1d12'; g.fillRect(hl + 8, -2.8, 4, 5.6); // gun and muzzle brake
      g.fillStyle = ol; g.beginPath(); g.ellipse(0, 0, 13, 10.5, 0, 0, 7); g.fill(); g.strokeStyle = olD; g.lineWidth = 0.9; g.stroke();
      g.fillStyle = olL; g.beginPath(); g.ellipse(-2, -3, 7, 4, 0, 0, 7); g.fill();
      g.fillStyle = olD; g.beginPath(); g.arc(-4, 3.5, 3, 0, 7); g.fill(); // hatch
      g.restore();
    } else if (C.kind === 'firetruck' && !wreck) {
      // the water cannon: a turning mount on the roof with a chrome nozzle
      g.save(); g.translate(hl - 30, 0); g.rotate(tur);
      g.fillStyle = '#1e1f23'; g.beginPath(); g.arc(0, 0, 5, 0, 7); g.fill();
      g.fillStyle = '#c9ccd2'; rr(g, 1, -1.6, 11, 3.2, 1.2); g.fill(); g.fillStyle = '#e9ecf0'; g.fillRect(1.5, -1.3, 10, 0.9);
      g.fillStyle = '#7d838c'; g.fillRect(10.5, -2.2, 2.4, 4.4);
      g.fillStyle = '#d23a2a'; g.beginPath(); g.arc(0, 0, 3, 0, 7); g.fill(); g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(-0.8, -0.8, 1.2, 0, 7); g.fill();
      g.restore();
    } else if (C.kind === 'boat' && !wreck) {
      // a round turret with the two guns side by side on it
      g.save(); g.translate(hl - 16, 0); g.rotate(tur);
      g.fillStyle = '#16171a'; for (const s of [-1, 1]) { g.fillRect(2, s * 2.6 - 1, 13, 2); g.fillRect(12.5, s * 2.6 - 1.5, 2.5, 3); }
      g.fillStyle = '#3a3c40'; g.beginPath(); g.arc(0, 0, 5, 0, 7); g.fill(); g.strokeStyle = '#1e1f22'; g.lineWidth = 0.8; g.stroke();
      g.fillStyle = '#55585e'; g.beginPath(); g.arc(-1, -1, 2, 0, 7); g.fill();
      g.restore();
    }
  }
  function drawSpecialSprite(g, C, hl, hw, L, Wd, body, dark, light, glass, wreck, R) {
    const rr2 = (x, y, w, h, r, f, st) => { rr(g, x, y, w, h, r); g.fillStyle = f; g.fill(); if (st) { g.strokeStyle = st; g.lineWidth = 0.8; g.stroke(); } };
    if (C.kind === 'tank') {
      const ol = wreck ? '#2c2926' : '#56602f', olD = wreck ? '#1d1b19' : '#3b4220', olL = wreck ? '#3a3632' : '#727d42';
      // tracks
      for (const s of [-1, 1]) {
        rr2(-hl, s > 0 ? hw - 8 : -hw, L, 8, 2, '#1c1c1a', '#000');
        g.fillStyle = '#34342f'; for (let x = -hl + 2; x < hl - 2; x += 4) g.fillRect(x, s > 0 ? hw - 7.5 : -hw + 0.5, 1.6, 7);
      }
      // hull
      rr2(-hl + 3, -hw + 6, L - 6, Wd - 12, 3, ol, olD);
      g.fillStyle = olL; g.fillRect(-hl + 5, -hw + 7, L - 10, 2.2);
      g.fillStyle = olD; g.fillRect(hl - 10, -hw + 8, 6, Wd - 16); // front glacis
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(-hl + 4, -3, 8, 6); // engine deck
      if (!wreck) { g.fillStyle = '#e8e3c8'; g.font = 'bold 4px sans-serif'; g.fillText('★', -hl + 14, 2); }
      else drawTurret(g, C, 0, true); // a working tank's turret turns, so it's drawn live (drawTurret)
      return;
    }
    // speedboat
    const hull = wreck ? '#2c2926' : '#f2f0ea', stripe = wreck ? '#1d1b19' : body;
    g.beginPath(); g.moveTo(hl + 2, 0); g.quadraticCurveTo(hl - 6, -hw, hl - 18, -hw); g.lineTo(-hl + 2, -hw + 1); g.lineTo(-hl, -hw + 3); g.lineTo(-hl, hw - 3); g.lineTo(-hl + 2, hw - 1); g.lineTo(hl - 18, hw); g.quadraticCurveTo(hl - 6, hw, hl + 2, 0); g.closePath();
    g.fillStyle = hull; g.fill(); g.strokeStyle = wreck ? '#000' : '#9aa0a6'; g.lineWidth = 0.9; g.stroke();
    g.save(); g.clip(); g.fillStyle = stripe; g.fillRect(-hl, -hw, L + 4, 3); g.fillRect(-hl, hw - 3, L + 4, 3); g.restore();
    g.fillStyle = wreck ? '#222' : shade(body, 0.35); rr(g, -hl + 6, -hw + 4, L * 0.5, Wd - 8, 3); g.fill(); // cockpit deck
    g.fillStyle = glass; g.beginPath(); g.moveTo(4, -hw + 4); g.quadraticCurveTo(10, 0, 4, hw - 4); g.lineTo(1, hw - 5); g.quadraticCurveTo(6, 0, 1, -hw + 5); g.closePath(); g.fill(); // windscreen
    g.fillStyle = wreck ? '#111' : '#2a2b2f'; g.fillRect(-hl - 3, -4, 6, 8); // outboard motor
    // (the minigun on the bow sits on a turret, drawn live by drawTurret)
    if (wreck) for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.ellipse((R() - 0.5) * L * 0.8, (R() - 0.5) * Wd * 0.6, 2 + R() * 4, 1 + R() * 3, R() * 3, 0, 7); g.fill(); }
  }
  function carSprite(t, col, wreck) {
    const key = t * 100 + col * 2 + (wreck ? 1 : 0);
    let c = carCache.get(key);
    if (c) return c;
    const C = S.CARS[t], L = C.len, Wd = C.wid, hl = L / 2, hw = Wd / 2, SC = 3;
    c = document.createElement('canvas');
    c.width = (L + 8) * SC; c.height = (Wd + 8) * SC;
    const g = c.getContext('2d');
    g.scale(SC, SC); g.translate((L + 8) / 2, (Wd + 8) / 2);
    const body = wreck ? '#2c2926' : S.CAR_COLORS[col];
    const dark = shade(body, -0.4), light = shade(body, 0.22);
    const glass = wreck ? '#151515' : '#1c2938';
    const R = S.rng(key);
    if (C.kind === 'tank' || C.kind === 'boat') { drawSpecialSprite(g, C, hl, hw, L, Wd, body, dark, light, glass, wreck, R); carCache.set(key, c); return c; }
    const k0 = C.kind, boxy = k0 === 'bus' || k0 === 'van' || k0 === 'firetruck';
    // the body's outline: cars are rounded off at the nose and tail; the bus, van and fire engine stay boxy
    const outline = () => {
      if (boxy) { rr(g, -hl, -hw, L, Wd, 3); return; }
      const nose = 0.86, tail = 0.9;
      g.beginPath();
      g.moveTo(-hl + 4, -hw * tail);
      g.quadraticCurveTo(-hl * 0.2, -hw * 1.02, hl * 0.55, -hw);
      g.quadraticCurveTo(hl, -hw * 0.98, hl, -hw * nose * 0.55);
      g.lineTo(hl, hw * nose * 0.55);
      g.quadraticCurveTo(hl, hw * 0.98, hl * 0.55, hw);
      g.quadraticCurveTo(-hl * 0.2, hw * 1.02, -hl + 4, hw * tail);
      g.quadraticCurveTo(-hl - 0.5, hw * tail, -hl, hw * tail * 0.6);
      g.lineTo(-hl, -hw * tail * 0.6);
      g.quadraticCurveTo(-hl - 0.5, -hw * tail, -hl + 4, -hw * tail);
      g.closePath();
    };
    // paint lit across its width, as if the body were round in section: bright near the top edge (the sun's side),
    // dark at both sides
    const paintAcross = (colr, y0 = -hw, y1 = hw) => {
      const gw = g.createLinearGradient(0, y0, 0, y1);
      gw.addColorStop(0, shade(colr, -0.45)); gw.addColorStop(0.18, shade(colr, 0.14)); gw.addColorStop(0.5, shade(colr, 0.04));
      gw.addColorStop(0.82, shade(colr, -0.1)); gw.addColorStop(1, shade(colr, -0.55));
      return gw;
    };
    const bodyCol = k0 === 'firetruck' ? (wreck ? '#2c2926' : '#c41e1a') : body;
    outline(); g.fillStyle = paintAcross(bodyCol); g.fill();
    // tinted glass, darker at the edges, for every window
    const glassG = g.createLinearGradient(-hl, -hw, hl, hw);
    if (wreck) { glassG.addColorStop(0, '#111'); glassG.addColorStop(1, '#1a1a1a'); }
    else { glassG.addColorStop(0, '#0a0f17'); glassG.addColorStop(0.45, '#22324a'); glassG.addColorStop(0.55, '#1a2738'); glassG.addColorStop(1, '#0b1119'); }
    const quad = (pts, fill) => { g.fillStyle = fill === glass ? glassG : fill; g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); g.fill(); };
    const cabin = (f0, f1, r0, r1, roofCol) => {
      // windshield f0..f1 (front), roof r0..f0, rear window r1..r0
      quad([f1, -hw + 3, f1, hw - 3, f0, hw - 2, f0, -hw + 2], glass);
      if (!wreck) { // a slanted sky reflection across the windscreen
        g.save(); g.beginPath(); g.moveTo(f1, -hw + 3); g.lineTo(f1, hw - 3); g.lineTo(f0, hw - 2); g.lineTo(f0, -hw + 2); g.clip();
        g.fillStyle = 'rgba(175,215,255,.3)'; g.beginPath(); g.moveTo(f0 + (f1 - f0) * 0.3, -hw); g.lineTo(f0 + (f1 - f0) * 0.6, -hw); g.lineTo(f0 + (f1 - f0) * 0.25, hw); g.lineTo(f0 - 1, hw); g.fill();
        g.restore();
      }
      g.fillStyle = paintAcross(roofCol, -hw + 2, hw - 2); rr(g, r0, -hw + 2, f0 - r0, Wd - 4, 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 0.5; rr(g, r0, -hw + 2, f0 - r0, Wd - 4, 2); g.stroke();
      if (r1 < r0) quad([r0, -hw + 2.5, r0, hw - 2.5, r1, hw - 4, r1, -hw + 4], glass);
      g.fillStyle = body; g.fillRect(f0 - 1, -hw - 1.5, 2, 2); g.fillRect(f0 - 1, hw - 0.5, 2, 2);
    };
    const k = C.kind;
    if (k === 'car' || k === 'taxi' || k === 'muscle' || k === 'police') {
      if (k === 'police' && !wreck) { g.fillStyle = '#16181c'; g.fillRect(L * 0.24, -hw + 1, hl - L * 0.24 - 1, Wd - 2); g.fillRect(-hl + 1, -hw + 1, hl * 0.4, Wd - 2); }
      cabin(L * 0.1, L * 0.24, -L * 0.2, -L * 0.3, light);
      if (k === 'police' && !wreck) {
        // light bar: red and blue lenses with a glow round them, chrome in the middle
        const bx = -L * 0.06 + 2;
        for (const [sgn, col, glow] of [[-1, '#ff2a22', 'rgba(255,40,30,.5)'], [1, '#2f6bff', 'rgba(50,110,255,.55)']]) {
          const gg = g.createRadialGradient(bx, sgn * 3.5, 0.5, bx, sgn * 3.5, 6.5); gg.addColorStop(0, glow); gg.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gg; g.fillRect(bx - 7, sgn * 3.5 - 7, 14, 14);
          g.fillStyle = col; rr(g, bx - 2, sgn > 0 ? 0.8 : -hw + 3, 4, hw - 3.8, 1.2); g.fill();
          g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(bx - 1.3, sgn > 0 ? 1.4 : -hw + 3.6, 1.1, hw - 5);
        }
        g.fillStyle = '#c3c8d0'; g.fillRect(bx - 2, -0.8, 4, 1.6);
      }
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(L * 0.27, -0.5, hl - L * 0.29, 1);
      if (k === 'taxi') { g.fillStyle = '#f2f2ee'; g.fillRect(-L * 0.08, -4, 6, 8); g.fillStyle = '#222'; g.fillRect(-L * 0.08, -4, 3, 4); g.fillRect(-L * 0.08 + 3, 0, 3, 4); }
      if (k === 'muscle') { g.fillStyle = wreck ? '#111' : '#151515'; g.fillRect(L * 0.27, -3, 7, 6); g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(-hl + 2, -2.5, L - 4, 1.5); g.fillRect(-hl + 2, 1, L - 4, 1.5); }
    } else if (k === 'sports') {
      if (!wreck) { g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(-hl + 2, -3, L - 4, 1.6); g.fillRect(-hl + 2, 1.4, L - 4, 1.6); }
      cabin(L * 0.02, L * 0.17, -L * 0.14, -L * 0.24, light);
      g.fillStyle = dark; g.fillRect(-hl + 1, -hw + 3, 3, Wd - 6);
    } else if (k === 'pickup') {
      cabin(L * 0.16, L * 0.28, -L * 0.04, -L * 0.08, light);
      g.fillStyle = dark; g.fillRect(-hl + 2, -hw + 2, hl - L * 0.1, Wd - 4);
      g.fillStyle = '#2a2a2a'; g.fillRect(-hl + 4, -hw + 4, hl - L * 0.1 - 4, Wd - 8);
      g.fillStyle = 'rgba(255,255,255,.07)'; for (let x = -hl + 6; x < -L * 0.1; x += 4) g.fillRect(x, -hw + 4, 1, Wd - 8);
    } else if (k === 'van') {
      quad([L * 0.4, -hw + 3, L * 0.4, hw - 3, L * 0.3, hw - 2, L * 0.3, -hw + 2], glass);
      g.fillStyle = shade(body, 0.12); g.fillRect(-hl + 2, -hw + 2, hl + L * 0.3 - 2, Wd - 4);
      g.fillStyle = 'rgba(0,0,0,.12)'; for (let x = -hl + 6; x < L * 0.28; x += 6) g.fillRect(x, -hw + 2, 1, Wd - 4);
    } else if (k === 'firetruck') {
      // a red fire engine: cab with a white roof, a ladder along the back, the water cannon on top
      const red = wreck ? '#2c2926' : '#c41e1a';
      quad([hl - 2, -hw + 3, hl - 2, hw - 3, hl - 8, hw - 2, hl - 8, -hw + 2], glass);
      g.fillStyle = wreck ? '#333' : '#f0eee8'; g.fillRect(hl - 22, -hw + 2, 13, Wd - 4);
      g.fillStyle = wreck ? '#222' : '#2a2a2e'; g.fillRect(hl - 23, -hw + 2, 1.5, Wd - 4);
      g.fillStyle = wreck ? '#444' : '#c9ccd2'; g.fillRect(-hl + 4, -5, L - 30, 2); g.fillRect(-hl + 4, 3, L - 30, 2);
      for (let x = -hl + 7; x < hl - 28; x += 5) g.fillRect(x, -5, 1.4, 10);
      g.fillStyle = wreck ? '#222' : '#e8c21c'; g.fillRect(-hl + 2, -hw + 1, L - 26, 1.6); g.fillRect(-hl + 2, hw - 2.6, L - 26, 1.6);
      if (wreck) { g.fillStyle = '#2a2a2e'; g.beginPath(); g.arc(hl - 30, 0, 4, 0, 7); g.fill(); } // (the water cannon itself turns: drawTurret)
      if (!wreck) { g.fillStyle = '#1d4fb8'; g.fillRect(hl - 21, -hw + 2.5, 3, 4); g.fillStyle = '#d22'; g.fillRect(hl - 21, hw - 6.5, 3, 4); }
    } else if (k === 'bus') {
      quad([hl - 2, -hw + 3, hl - 2, hw - 3, hl - 7, hw - 2, hl - 7, -hw + 2], glass);
      g.fillStyle = wreck ? '#333' : '#e9e7df'; g.fillRect(-hl + 3, -hw + 4, L - 12, Wd - 8);
      g.fillStyle = glass; g.fillRect(-hl + 5, -hw + 1, L - 14, 3); g.fillRect(-hl + 5, hw - 4, L - 14, 3);
      g.fillStyle = '#777'; g.fillRect(-hl + 20, -4, 10, 8); g.fillRect(4, -4, 10, 8);
      g.fillStyle = 'rgba(0,0,0,.1)'; for (let x = -hl + 8; x < hl - 10; x += 10) g.fillRect(x, -hw + 4, 1, Wd - 8);
    }
    if (!wreck) {
      // clear coat: soft white streaks across the paint and glass, and a thin rim of light along the sunny edge
      g.save(); outline(); g.clip();
      for (const [x, w, a] of [[hl * 0.45, 5, 0.26], [-hl * 0.55, 4, 0.18], [hl * 0.05, 2, 0.12]]) {
        const gs = g.createLinearGradient(x - w, 0, x + w, 0);
        gs.addColorStop(0, 'rgba(255,255,255,0)'); gs.addColorStop(0.5, `rgba(255,255,255,${a})`); gs.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gs; g.fillRect(x - w, -hw, w * 2, Wd);
      }
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 0.6; g.beginPath(); g.moveTo(-hl * 0.75, -hw + 0.8); g.lineTo(hl * 0.65, -hw + 0.8); g.stroke();
      g.restore();
    }
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 0.7; outline(); g.stroke();
    if (!wreck) {
      // headlights with a glow, tail lights glowing red, wing mirrors
      for (const sgn of [-1, 1]) {
        const hy = sgn * (hw - 4.2);
        const gh = g.createRadialGradient(hl, hy, 0.3, hl, hy, 5); gh.addColorStop(0, 'rgba(255,250,220,.6)'); gh.addColorStop(1, 'rgba(255,250,220,0)');
        g.fillStyle = gh; g.fillRect(hl - 5, hy - 5, 10, 10);
        g.fillStyle = '#fffbe8'; rr(g, hl - 2.6, hy - 2, 2.6, 4, 1); g.fill();
        g.fillStyle = 'rgba(255,60,40,.3)'; g.fillRect(-hl - 1, sgn * (hw - 4) - 2.6, 3, 5.2);
        g.fillStyle = '#ff2b1c'; rr(g, -hl + 0.1, sgn * (hw - 4) - 2, 1.9, 4, 0.8); g.fill();
        if (!boxy) { g.fillStyle = shade(body, -0.15); rr(g, L * 0.08, sgn * (hw + 0.4) - 1, 2.6, 2, 0.8); g.fill(); }
      }
    } else {
      for (let i = 0; i < 9; i++) { g.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.6)' : 'rgba(90,50,20,.5)'; g.beginPath(); g.ellipse((R() - 0.5) * L * 0.9, (R() - 0.5) * Wd * 0.8, 2 + R() * 5, 1 + R() * 3, R() * 3, 0, 7); g.fill(); }
    }
    carCache.set(key, c);
    return c;
  }

  // ---------------------------------------------------------------- peds
  const PED_COLS = ['#7a6a55', '#4f6d7a', '#8c4b4b', '#5b7b4a', '#9b8b6e', '#6a5a8a', '#b0703c', '#3f5f8f', '#8a8a82', '#a65e7d', '#556b2f', '#c2a14d'];
  const popups = [];
  const newPedAnim = (x, y) => ({ x, y, a: 0, ph: 0, amp: 0, air: false, sq: 9, sqk: 0, ox: 0, oy: 0, ot: 9 });
  const GANG_COL = '#2f7d32'; // gang members' green jackets
  let crewHintDone = false;
  // someone swimming: only the head and shoulders above the water, arms doing the crawl, ripples spreading, and a
  // splash now and then
  function drawSwimmer(x, y, a, col, cop, gang, an, mv, t, dt) {
    const ph = t * 5 + (an.x * 0.01);
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = 'rgba(225,240,255,.55)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 2; i++) { const f = (t * 0.9 + i * 0.5) % 1; ctx.globalAlpha = 0.6 * (1 - f); ctx.beginPath(); ctx.ellipse(0, 0, 9 + f * 14, 7 + f * 11, a, 0, 7); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.rotate(a);
    ctx.fillStyle = 'rgba(20,40,70,.35)'; ctx.beginPath(); ctx.ellipse(-3, 0, 8, 6, 0, 0, 7); ctx.fill(); // the body, under the water
    // arms: one reaching forward, one pulling back, swapping over
    const s1 = Math.sin(ph), arm = (side, f) => { ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, side * 4); ctx.lineTo(4 + f * 7, side * (6 - Math.abs(f) * 2)); ctx.stroke(); };
    if (mv) { arm(-1, s1); arm(1, -s1); }
    ctx.fillStyle = '#e0b48c'; ctx.beginPath(); ctx.arc(1, 0, 4, 0, 7); ctx.fill(); // head
    if (cop) { ctx.fillStyle = '#121a3d'; ctx.beginPath(); ctx.arc(1.4, 0, 4.2, 0, 7); ctx.fill(); ctx.fillStyle = '#0b0f22'; ctx.fillRect(4.2, -2.8, 2, 5.6); ctx.fillStyle = '#e8c547'; ctx.fillRect(0.8, -0.8, 1.4, 1.6); }
    else if (gang) { ctx.fillStyle = '#c4161c'; ctx.beginPath(); ctx.arc(1, 0, 4.2, Math.PI * 0.55, Math.PI * 1.45); ctx.fill(); }
    ctx.restore();
    an.sw = (an.sw || 0) - dt;
    if (mv && an.sw <= 0) {
      an.sw = 0.55 + Math.random() * 0.3;
      const fx = x + Math.cos(a) * 9, fy = y + Math.sin(a) * 9;
      for (let i = 0; i < 5; i++) { const aa = rnd(0, 7), sp = rnd(20, 60); addP({ t: 'water', x: fx, y: fy, vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp, life: rnd(0.2, 0.4), max: 0.4 }); }
      Audio.play('splash', fx, fy, 0.35);
    }
  }
  // what someone looks like: skin, hair, trousers and haircut, picked from their id so they always look the same
  const SKINS = ['#f1c7a1', '#d9a777', '#c08a5e', '#97633f', '#6e4329'], HAIRS = ['#2b1d14', '#121212', '#5a3a1a', '#8a6a3a', '#cfa75a', '#7a7a7a', '#a0371b'];
  const PANTS = ['#25262b', '#2d3a5a', '#3d3a33', '#4a3b2a', '#1d2b40', '#4b4f56'];
  function pedLook(id) { const h = Math.imul((id | 0) + 7, 2654435761) >>> 0; return { skin: SKINS[h % 5], hair: HAIRS[(h >>> 4) % 7], pants: PANTS[(h >>> 8) % 6], style: [0, 0, 0, 1, 1, 2, 3, 3][(h >>> 12) % 8] }; }
  const DEF_LOOK = { skin: '#d9a777', hair: '#2b1d14', pants: '#25262b', style: 0 };
  // a person seen from above, facing +x. Animated like a modern top-down game: a run cycle with counter-rotating
  // shoulders and a bounce, a lean into turns, arms that swing (or carry the gun: rifles low across the body while
  // running, snapped up to aim when firing), recoil on every shot, a quick lowered-and-raised swap when the weapon
  // changes, and breathing when standing still. an: the person's own animation state (optional), firing: shooting now
  const RECOIL = [2.2, 1.6, 1.3, 4.2, 0.6, 0.4, 4.8, 0, 0]; // how hard each weapon kicks
  function drawPed(g, x, y, a, color, phase, moving, alpha, weapon, lying, sc = 1, sqx = 1, sqy = 1, punch = null, look = DEF_LOOK, an = null, firing = false) {
    const now = performance.now() / 1000;
    // ---- the animation state: turning, aiming, recoil, weapon swaps
    let turn = 0, aim = firing ? 1 : moving > 0.3 ? 0.15 : 0.75, rc = 0, swap = 0, fireT = 9;
    if (an) {
      const dtl = an.lt ? clamp(now - an.lt, 0, 0.1) : 0; an.lt = now;
      if (an.pa === undefined) an.pa = a;
      const da = S.angDiff(a, an.pa); an.pa = a;
      an.turn = damp(an.turn || 0, dtl > 0 ? clamp(da / dtl, -12, 12) : 0, 10, dtl || 0.016);
      an.aim = damp(an.aim === undefined ? aim : an.aim, aim, firing ? 22 : 7, dtl || 0.016);
      if (an.w !== weapon) { if (an.w !== undefined) an.swapT = 0; an.w = weapon; }
      an.swapT = (an.swapT === undefined ? 9 : an.swapT) + dtl;
      // a shot every weapon-rate seconds while the trigger is held: each one kicks
      const W = S.WEAPONS[weapon];
      an.fire = (an.fire || 0) + (firing ? dtl : 0);
      if (firing && W && an.fire >= W.rate) { an.fire = 0; an.rc = RECOIL[weapon] || 0; an.rr = (Math.random() - 0.5) * 0.12; an.fireT = 0; }
      if (!firing) an.fire = W ? W.rate : 0; // first shot kicks straight away
      an.rc = (an.rc || 0) * Math.exp(-dtl * 18); an.fireT = (an.fireT === undefined ? 9 : an.fireT) + dtl;
      turn = an.turn; aim = an.aim; rc = an.rc; fireT = an.fireT;
      swap = an.swapT < 0.32 ? 1 - E.outBack(an.swapT / 0.32) : 0;
    }
    const m = moving || 0, sP = Math.sin(phase), s = sP * m, bounce = 1 + 0.045 * Math.abs(sP) * m;
    const breathe = (1 - m) * Math.sin(now * 2.3 + (look.style || 0)) * 0.018;
    const twist = -s * 0.17; // shoulders swing against the legs
    const lat = clamp(turn * 0.55, -2.2, 2.2) * (0.4 + m * 0.6); // leaning into a turn
    g.save(); g.translate(x, y); g.rotate(a); if (sc !== 1 || sqx !== 1 || sqy !== 1) g.scale(sc * sqx, sc * sqy);
    g.globalAlpha = alpha;
    const skin = look.skin, ol = 'rgba(0,0,0,.55)';
    // ---- legs and shoes: a longer stride the faster you go, the back foot rolling up onto its toes
    g.lineCap = 'round';
    if (lying) {
      g.fillStyle = look.pants; g.fillRect(-14, -5, 10, 3.2); g.fillRect(-14, 1.8, 10, 3.2);
      g.fillStyle = '#141414'; g.fillRect(-16, -5.2, 3, 3.6); g.fillRect(-16, 1.6, 3, 3.6);
    } else {
      const kk = an && an.kick ? Math.sin(Math.PI * clamp(an.kick.t / 0.36, 0, 1)) : 0; // a kick: the right leg snaps out front
      for (const [side, k] of [[-1, s], [1, -s]]) {
        const off = k * 6.2 * (1 - kk) + (side > 0 ? kk * 12 : -kk * 2), ly = side * 3.2 + lat * 0.3, lift = Math.max(0, -k) * 0.5; // the back foot shrinks a little: heel up
        g.strokeStyle = look.pants; g.lineWidth = 3.6; g.beginPath(); g.moveTo(-1, ly); g.lineTo(2.2 + off, ly); g.stroke();
        g.fillStyle = '#111'; g.beginPath(); g.ellipse(3.3 + off, ly, 1.95 - lift, 1.35, 0, 0, 7); g.fill();
        g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(3.1 + off, ly - 1, 1.5, 0.6);
      }
    }
    // ---- everything above the hips: twisted, bounced, leaning
    g.save();
    g.translate(m * 0.7, lat); g.rotate(twist + lat * 0.04); g.scale(bounce + breathe, bounce + breathe);
    if (weapon === 5 && !lying) { // the flamethrower's fuel tank on the back
      g.fillStyle = '#7a2a1a'; rr(g, -9.2, -3.4, 4.4, 6.8, 1.6); g.fill(); g.fillStyle = '#b8462a'; rr(g, -8.8, -3, 2.2, 6, 1); g.fill(); g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(-8.4, -2.6, 0.8, 5.2);
    }
    // torso: a jacket, lit from above, with shoulder seams and a collar
    const tg = g.createRadialGradient(-1, -2.5, 0.5, 0, 0, 9);
    tg.addColorStop(0, shade(color, 0.28)); tg.addColorStop(0.55, color); tg.addColorStop(1, shade(color, -0.4));
    g.fillStyle = tg; g.beginPath(); g.ellipse(0, 0, 5.2, 8.2, 0, 0, 7); g.fill();
    g.strokeStyle = ol; g.lineWidth = 0.8; g.stroke();
    g.strokeStyle = shade(color, -0.45); g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(-2.6, -5.6); g.quadraticCurveTo(0.6, -6.6, 2.8, -5); g.moveTo(-2.6, 5.6); g.quadraticCurveTo(0.6, 6.6, 2.8, 5); g.moveTo(-4.6, 0); g.lineTo(-1.6, 0); g.stroke();
    g.fillStyle = shade(color, -0.35); g.beginPath(); g.ellipse(2.6, 0, 1.6, 3.6, 0, -1.6, 1.6); g.fill(); // collar
    // ---- arms (shoulder to hand) and whatever is in the hands
    const sleeve = shade(color, -0.08);
    const arm = (sy, hx, hy, fist) => {
      const sx = -0.4;
      g.strokeStyle = ol; g.lineWidth = 3.3; g.beginPath(); g.moveTo(sx, sy); g.lineTo(hx, hy); g.stroke();
      g.strokeStyle = sleeve; g.lineWidth = 2.5; g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (hx - sx) * 0.82, sy + (hy - sy) * 0.82); g.stroke();
      if (fist) { g.fillStyle = '#000'; g.beginPath(); g.arc(hx, hy, 2.6, 0, 7); g.fill(); }
      g.fillStyle = skin; g.beginPath(); g.arc(hx, hy, fist ? 1.9 : 1.5, 0, 7); g.fill();
    };
    // a gun (or tube) drawn along +x from 0 to len, from a pivot and angle
    const gun = (px, py, ang, len, w, col, fn) => {
      g.save(); g.translate(px, py); g.rotate(ang);
      g.fillStyle = col; rr(g, -3, -w / 2, len + 3, w, Math.min(1.2, w / 2)); g.fill();
      g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(-2.5, -w / 2 + 0.3, len + 2, Math.max(0.5, w * 0.22));
      if (fn) fn();
      g.restore();
    };
    const rot = (px, py, ang, lx, ly) => [px + Math.cos(ang) * lx - Math.sin(ang) * ly, py + Math.sin(ang) * lx + Math.cos(ang) * ly];
    const swing = (side) => s * side * 3.6; // free arms swing opposite to the legs
    const low = swap * 1.2; // mid-swap: the weapon dips down out of sight and comes back up
    if (lying) { g.fillStyle = skin; g.fillRect(0, -12, 3, 5); g.fillRect(0, 7, 3, 5); }
    else if (weapon === S.FISTS) {
      // fists up, bobbing with the run; a punch shoots one arm out and back
      let ex = 0, side = 1;
      if (punch) { const k = clamp(punch.t / 0.24, 0, 1); ex = Math.sin(Math.PI * Math.pow(k, 0.6)) * 9; side = punch.side; }
      if (an && an.bst === 3) { for (const s2 of [-1, 1]) arm(s2 * 5.4, 7.2, s2 * 1.6, true); } // blocking: both fists up in front
      else if (an && an.grab) { const k = Math.sin(Math.PI * clamp(an.grab.t / 0.3, 0, 1)); for (const s2 of [-1, 1]) arm(s2 * 5.4, 6 + k * 6, s2 * (4.6 - k * 2), true); } // a grab: both hands shoot out
      else for (const s2 of [-1, 1]) {
        const out = s2 === side ? ex : 0, yy = s2 * (out > 0 ? 3.4 : 5.4);
        arm(s2 * 5.4, 5.6 + out + s * s2 * 1.2, yy, true);
      }
    } else if (weapon === 0) {
      // pistol: gun hand forward, ready; the other arm swings, or comes in to steady the gun when shooting
      const k = aim * (1 - low), hx = lerp(5.2, 9.4, k) - rc, hy = lerp(4.2, 1.6, k);
      arm(-5.4, lerp(1.8 + swing(-1), 7.4 - rc * 0.6, k), lerp(-6.2, 0.2, k));
      arm(5.4, hx, hy);
      gun(hx, hy, lerp(0.35, 0, k) + (an ? an.rr || 0 : 0) * rc - low, 5.5, 2.4, '#1b1b1d');
    } else if (weapon === 1) {
      // two pistols, one in each hand, kicking in turns
      for (const sd of [-1, 1]) {
        const kick = (sd > 0) === ((fireT * 10 | 0) % 2 === 0) ? rc : 0, hx = lerp(5.4 + swing(sd) * 0.4, 9.2, aim) - kick - low * 3, hy = sd * lerp(5, 3.6, aim);
        arm(sd * 5.4, hx, hy); gun(hx, hy, sd * lerp(0.25, 0.05, aim) - low * sd, 5.2, 2.3, '#1b1b1d');
      }
    } else if (weapon >= 2 && weapon <= 6) {
      // long guns: carried low across the body when running, snapped up to the shoulder to shoot
      const rocket = weapon === 6, len = [0, 0, 14, 13, 11, 12, 18][weapon];
      const px = rocket ? -6 : lerp(-3.2, -1.2, aim) - rc, py = (rocket ? 4.4 : lerp(2.2, 3.4, aim)) + low;
      const ang = lerp(rocket ? -0.18 : -0.62, 0, aim) + s * 0.09 * (1 - aim) + (an ? an.rr || 0 : 0) * rc * 0.5 - low * 0.6;
      const [rhx, rhy] = rot(px, py, ang, rocket ? 8 : 3.2, rocket ? 1.8 : 0.8), [fhx, fhy] = rot(px, py, ang, rocket ? 13 : len * 0.62, rocket ? -1 : -0.2);
      arm(5.4, rhx, rhy); arm(-5.4, fhx, fhy);
      if (rocket) gun(px, py, ang, len, 4.6, '#4f6b3a', () => { g.fillStyle = '#2c3d20'; g.fillRect(len - 1, -2.6, 2.2, 5.2); g.fillRect(-3, -2.6, 1.6, 5.2); g.fillStyle = '#1b1b1d'; g.fillRect(6, 2.2, 2, 2.4); });
      else if (weapon === 5) gun(px, py, ang, len, 2.8, '#3a3a3e', () => { g.fillStyle = '#b8462a'; g.fillRect(len - 2.5, -1.8, 2.5, 3.6); if (firing) { g.fillStyle = 'rgba(80,160,255,.9)'; g.beginPath(); g.arc(len + 0.6, 0, 1, 0, 7); g.fill(); } });
      else if (weapon === 4) gun(px, py, ang, len, 3, '#2b3550', () => { g.fillStyle = '#7fe6ff'; g.fillRect(3, -0.6, len - 4, 1.2); g.fillStyle = '#1b2236'; g.fillRect(len - 1.5, -2, 1.5, 4); });
      else if (weapon === 3) gun(px, py, ang, len, 2.6, '#1b1b1d', () => { g.fillStyle = '#6a4a2a'; g.fillRect(-3, -1.5, 4.5, 3); g.fillStyle = '#3a3a3a'; g.fillRect(len * 0.5, -1.4, 3, 2.8); });
      else gun(px, py, ang, len, 2.4, '#1b1b1d', () => { g.fillStyle = '#333'; g.fillRect(len * 0.35, 1, 2, 2.6); g.fillStyle = '#4a4a4a'; g.fillRect(-3, -1.6, 3.2, 3.2); });
    } else if (weapon === 7 || weapon === 8) {
      // grenade / molotov: held in the right hand; throwing whips the arm from behind to out in front
      const th = fireT < 0.3 ? fireT / 0.3 : 1, k = th < 1 ? E.outCubic(th) : 0;
      const hx = th < 1 ? lerp(-7, 9, k) : 2.6 + swing(1) * 0.6, hy = th < 1 ? lerp(6.6, 3, k) : 6.4;
      arm(-5.4, 1.8 + swing(-1), -6.4); arm(5.4, hx, hy);
      if (th >= 1) {
        if (weapon === 7) { g.fillStyle = '#3d5a2a'; g.beginPath(); g.arc(hx + 1.4, hy, 1.9, 0, 7); g.fill(); g.fillStyle = '#999'; g.fillRect(hx + 2.4, hy - 0.6, 1.2, 1.2); }
        else { g.fillStyle = '#2f6b2a'; rr(g, hx, hy - 1.2, 4.2, 2.4, 1); g.fill(); g.fillStyle = '#ffb030'; g.beginPath(); g.arc(hx + 4.8, hy, 0.9 + Math.random() * 0.5, 0, 7); g.fill(); }
      }
    } else {
      // empty hands: arms swing with the run
      arm(-5.4, 1.8 + swing(-1), -6.4 - Math.abs(s) * 0.4);
      arm(5.4, 1.8 + swing(1), 6.4 + Math.abs(s) * 0.4);
    }
    // ---- head: turns a touch less than the shoulders, so it stays looking where you're going
    g.rotate(-twist * 0.6);
    const hx = 1 + m * 0.4;
    g.fillStyle = shade(skin, -0.2); g.beginPath(); g.arc(hx - 0.2, -4.1, 1.1, 0, 7); g.arc(hx - 0.2, 4.1, 1.1, 0, 7); g.fill(); // ears
    const hg = g.createRadialGradient(hx + 0.8, -1, 0.4, hx, 0, 4.4); hg.addColorStop(0, shade(skin, 0.18)); hg.addColorStop(1, shade(skin, -0.22));
    g.fillStyle = hg; g.beginPath(); g.arc(hx, 0, 4.2, 0, 7); g.fill();
    g.strokeStyle = ol; g.lineWidth = 0.7; g.stroke();
    g.fillStyle = shade(skin, -0.15); g.beginPath(); g.ellipse(hx + 4.1, 0, 1, 0.9, 0, 0, 7); g.fill(); // nose
    if (look.style === 2) { g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(hx - 0.8, -1.2, 1.3, 0, 7); g.fill(); }
    else if (look.style === 3) {
      g.fillStyle = shade(color, -0.2); g.beginPath(); g.arc(hx - 0.3, 0, 4.3, 0, 7); g.fill();
      g.fillStyle = shade(color, -0.45); g.beginPath(); g.ellipse(hx + 3.8, 0, 2.2, 3.4, 0, -1.57, 1.57); g.fill();
      g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(hx - 1, -1.2, 1.4, 0, 7); g.fill();
    } else {
      // hair, with long hair trailing behind and swinging a little with the run
      const tail = look.style === 1 ? s * 0.5 - lat * 0.3 : 0;
      g.fillStyle = look.hair; g.beginPath();
      if (look.style === 1) g.ellipse(hx - 1.2 - m * 0.4, tail, 4.9, 4.8, 0, Math.PI * 0.3, Math.PI * 1.7);
      else g.arc(hx - 0.2, 0, 4.35, Math.PI * 0.3, Math.PI * 1.7);
      g.quadraticCurveTo(hx + 3.6, 0, hx + 1.4, 3.9 * Math.sin(Math.PI * 0.3)); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.22)'; g.beginPath(); g.ellipse(hx - 1.6, -1.4, 1.6, 0.8, -0.5, 0, 7); g.fill();
    }
    g.restore();
    g.restore();
  }

  // ================================================================ effects
  const parts = [], partsHi = [], tracers = [], zaps = [];
  let shake = 0;
  const says = new Map(); // speech bubbles: taunts, burps and farts (Tab)
  const dmgTexts = [], carDents = new Map(), brawlFlash = new Map(); // brawlFlash: who just broke free (a ring for a moment) // brawl hit numbers floating up; dents knocked into a car by thrown bodies
  function addP(o, hi) { const a = hi ? partsHi : parts; if (a.length < 1400) a.push(o); }
  function blood(x, y, n, big) {
    for (let i = 0; i < n; i++) { const a = rnd(0, 7), s = rnd(30, big ? 200 : 110); addP({ t: 'blood', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.15, 0.35), max: 0.35, sz: rnd(1.5, 3) }); }
    stamp(x, y, big ? 40 : 14, (g) => {
      g.fillStyle = 'rgba(120,0,0,.55)';
      for (let i = 0; i < (big ? 14 : 4); i++) { g.beginPath(); g.arc(x + rnd(-1, 1) * (big ? 22 : 7), y + rnd(-1, 1) * (big ? 22 : 7), rnd(1.5, big ? 7 : 3), 0, 7); g.fill(); }
    });
  }
  function sparks(x, y, n, col = '#ffe27a') {
    for (let i = 0; i < n; i++) { const a = rnd(0, 7), s = rnd(80, 260); addP({ t: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.1, 0.25), max: 0.25, col }); }
  }
  function smoke(x, y, sz = 10, dark = 0.5) { addP({ t: 'smoke', x: x + rnd(-4, 4), y: y + rnd(-4, 4), vx: rnd(-12, 12), vy: rnd(-12, 12), life: rnd(1, 1.8), max: 1.8, sz, dark }, true); }
  function fireP(x, y, sz = 8, hi) { addP({ t: 'fire', x: x + rnd(-5, 5), y: y + rnd(-5, 5), vx: rnd(-20, 20), vy: rnd(-20, 20), life: rnd(0.25, 0.55), max: 0.55, sz }, hi); }
  function explosionFx(x, y, R) {
    addP({ t: 'flash', x, y, life: 0.18, max: 0.18, sz: R * 1.1 }, true);
    addP({ t: 'ring', x, y, life: 0.35, max: 0.35, sz: R }, true);
    for (let i = 0; i < 26; i++) { const a = rnd(0, 7), s = rnd(20, R * 1.6); addP({ t: 'fire', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.35, 0.8), max: 0.8, sz: rnd(10, 22) }, true); }
    for (let i = 0; i < 16; i++) { const a = rnd(0, 7), s = rnd(10, R * 0.8); addP({ t: 'smoke', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(1.2, 2.4), max: 2.4, sz: rnd(14, 26), dark: 0.75 }, true); }
    for (let i = 0; i < 12; i++) { const a = rnd(0, 7), s = rnd(120, 380); addP({ t: 'debris', x, y, z: 0, vz: rnd(150, 350), vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.6, 1.2), max: 1.2, rot: rnd(0, 7) }); }
    stamp(x, y, R * 0.6, (g) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, R * 0.55);
      gr.addColorStop(0, 'rgba(10,8,6,.75)'); gr.addColorStop(0.6, 'rgba(10,8,6,.35)'); gr.addColorStop(1, 'rgba(10,8,6,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, R * 0.55, 0, 7); g.fill();
    });
  }
  function stepParts(arr, dt) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.life -= dt;
      if (p.life <= 0) { arr.splice(i, 1); continue; }
      p.x += (p.vx || 0) * dt; p.y += (p.vy || 0) * dt;
      if (p.t === 'smoke') { p.vx *= 0.97; p.vy *= 0.97; p.sz += dt * 14; }
      else if (p.t === 'fire') { p.vx *= 0.93; p.vy *= 0.93; }
      else if (p.t === 'flame') { const d = Math.pow(0.955, dt * 60); p.vx *= d; p.vy *= d; p.sz += dt * (24 + 110 * (1 - p.life / p.max)); } // swells as it slows: a cone, then billows
      else if (p.t === 'debris') {
        p.z += p.vz * dt; p.vz -= 900 * dt; p.rot += dt * 10;
        if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.5; p.vy *= 0.5; }
      } else if (p.t === 'champ' || p.t === 'confetti') {
        p.z += p.vz * dt; p.vz -= (p.t === 'confetti' ? 260 : 700) * dt;
        if (p.t === 'confetti') { p.rot += dt * 9; p.vx *= 0.98; p.vy *= 0.98; }
        if (p.z < 0) { p.z = 0; p.vz = 0; p.vx *= 0.4; p.vy *= 0.4; }
      } else if (p.t === 'foam') { p.vx *= 0.95; p.vy *= 0.95; p.sz += dt * 6; }
      else if (p.t === 'blood' || p.t === 'spark' || p.t === 'water') { p.vx *= 0.9; p.vy *= 0.9; }
    }
  }
  // soft round glows for the flamethrower, drawn once
  let flameSp = null;
  function flameSprites() {
    if (flameSp) return flameSp;
    const mk = (stops) => {
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); for (const [o, col] of stops) gr.addColorStop(o, col);
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c;
    };
    flameSp = {
      core: mk([[0, 'rgba(255,255,235,1)'], [0.35, 'rgba(255,244,160,.9)'], [0.7, 'rgba(255,200,60,.35)'], [1, 'rgba(255,170,40,0)']]),
      orange: mk([[0, 'rgba(255,214,90,.95)'], [0.45, 'rgba(255,150,30,.6)'], [0.8, 'rgba(240,90,20,.2)'], [1, 'rgba(220,60,10,0)']]),
      red: mk([[0, 'rgba(255,130,40,.7)'], [0.5, 'rgba(225,70,20,.35)'], [1, 'rgba(160,30,10,0)']]),
    };
    return flameSp;
  }
  function drawParts(g, arr) {
    for (const p of arr) {
      const f = p.life / p.max;
      switch (p.t) {
        case 'blood': g.fillStyle = '#8d0b0b'; g.fillRect(p.x, p.y, p.sz, p.sz); break;
        case 'spark': g.strokeStyle = p.col; g.globalAlpha = f; g.lineWidth = 1.5; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); g.stroke(); g.globalAlpha = 1; break;
        case 'water': g.fillStyle = 'rgba(200,225,255,' + f + ')'; g.fillRect(p.x, p.y, 2.5, 2.5); break;
        case 'champ': g.fillStyle = p.gold ? `rgba(255,226,120,${Math.min(1, f * 1.5)})` : `rgba(255,255,245,${Math.min(1, f * 1.5)})`; g.fillRect(p.x, p.y - p.z * 0.6, p.sz, p.sz); break;
        case 'foam': g.fillStyle = `rgba(255,252,235,${0.7 * f})`; g.beginPath(); g.arc(p.x, p.y, p.sz, 0, 7); g.fill(); break;
        case 'confetti': g.save(); g.translate(p.x, p.y - p.z * 0.6); g.rotate(p.rot); g.globalAlpha = Math.min(1, f * 2); g.fillStyle = p.col; g.fillRect(-2.5, -1.2, 5, 2.4); g.restore(); break;
        case 'smoke': if (p.col) { g.globalAlpha = 0.8 * f; g.fillStyle = p.col; g.beginPath(); g.arc(p.x, p.y, p.sz * (1.6 - f * 0.6), 0, 7); g.fill(); g.globalAlpha = 1; break; } { const c = (1 - p.dark) * 160 * (1 - 0.72 * sun.night) | 0; g.fillStyle = `rgba(${c},${c},${c},${0.45 * f})`; g.beginPath(); g.arc(p.x, p.y, p.sz, 0, 7); g.fill(); break; }
        case 'flame': {
          // a flamethrower jet: soft blobs that add up their light. White-hot and small at the nozzle, swelling into
          // yellow and orange, ending in big dim orange-red puffs
          const sp = flameSprites(), op = g.globalCompositeOperation;
          g.globalCompositeOperation = 'lighter';
          const r = p.sz * (1.15 - f * 0.35), a = f > 0.85 ? (1 - f) / 0.15 : 1; // fades in over the first moment, so the nozzle end is a point
          g.globalAlpha = Math.min(1, (0.25 + f * 0.75) * a);
          g.drawImage(f > 0.55 ? sp.orange : sp.red, p.x - r * 1.5, p.y - r * 1.5, r * 3, r * 3);
          if (f > 0.35) { g.globalAlpha = Math.min(1, (f - 0.35) * 1.8) * a; const rc = r * (0.45 + (f - 0.35)); g.drawImage(sp.core, p.x - rc * 1.4, p.y - rc * 1.4, rc * 2.8, rc * 2.8); }
          g.globalAlpha = 1; g.globalCompositeOperation = op;
          break;
        }
        case 'fire': {
          // every other fire (burning cars, molotovs, explosions, people on fire) looks like the flamethrower's:
          // soft blobs of light that add up, white-hot in the middle, then yellow, orange, and dim red as they die
          const sp = flameSprites(), op = g.globalCompositeOperation;
          // (the outer glow drawn normally, so it still shows up on bright pavement in daylight; the hot core adds light)
          const r = p.sz * (0.8 + (1 - f) * 0.7), a = f > 0.85 ? (1 - f) / 0.15 : 1;
          g.globalAlpha = Math.min(1, (0.35 + f * 0.65) * a);
          g.drawImage(f > 0.5 ? sp.orange : sp.red, p.x - r * 1.5, p.y - r * 1.5, r * 3, r * 3);
          g.globalCompositeOperation = 'lighter';
          if (f > 0.42) { g.globalAlpha = Math.min(1, (f - 0.42) * 2) * a; const rc = r * (0.42 + (f - 0.42)); g.drawImage(sp.core, p.x - rc * 1.4, p.y - rc * 1.4, rc * 2.8, rc * 2.8); }
          g.globalAlpha = 1; g.globalCompositeOperation = op;
          break;
        }
        case 'flash': g.fillStyle = `rgba(255,240,190,${f * f})`; g.beginPath(); g.arc(p.x, p.y, p.sz * (0.55 + 0.7 * E.outCubic(1 - f)), 0, 7); g.fill(); break;
        case 'ring': g.strokeStyle = `rgba(255,255,255,${f * 0.6})`; g.lineWidth = 4 * f + 1; g.beginPath(); g.arc(p.x, p.y, p.sz * E.outCubic(1 - f) + 8, 0, 7); g.stroke(); break;
        case 'muzzle': {
          const k = E.outCubic(f);
          g.save(); g.translate(p.x, p.y); g.rotate(p.a || 0);
          g.fillStyle = `rgba(255,236,150,${k})`; g.beginPath(); g.ellipse(6 + 4 * k, 0, 4 + 8 * k, 1.5 + 2.5 * k, 0, 0, 7); g.fill();
          g.fillStyle = `rgba(255,255,230,${k})`; g.beginPath(); g.arc(1, 0, 2 + 3 * k, 0, 7); g.fill();
          g.restore(); break;
        }
        case 'debris': {
          const s = 1 + p.z / 200;
          g.save(); g.translate(p.x, p.y - p.z * 0.15); g.rotate(p.rot); g.fillStyle = '#2a2622'; g.fillRect(-2.5 * s, -1.5 * s, 5 * s, 3 * s); g.restore(); break;
        }
      }
    }
  }

  // ================================================================ race mode
  const race = { champ: null, lastCount: 0, flash: 0 };
  const rcInfo = () => (game && game.rc) || null;
  function myRace() {
    const rc = rcInfo();
    if (!rc || (rc[0] !== 1 && rc[0] !== 2)) return null;
    for (let i = 5; i + 2 < rc.length; i += 3) if (rc[i] === myId) return { lap: rc[i + 1], next: rc[i + 2] };
    return null;
  }
  function myPos() {
    if (pred.mode === 'car') return { x: pred.c.x + off.x, y: pred.c.y + off.y };
    if (pred.mode === 'ped') return { x: pred.p.x + off.x, y: pred.p.y + off.y };
    return null;
  }
  // everyone's place: laps done, checkpoints done, then who's closer to their next one
  function raceStandings() {
    const rc = rcInfo(), cps = map && map.race ? map.race.cps : [];
    if (!rc || !cps.length) return [];
    const snap = snaps[snaps.length - 1], N = cps.length, out = [];
    for (let i = 5; i + 2 < rc.length; i += 3) {
      const id = rc[i], lap = rc[i + 1], next = rc[i + 2];
      let pos = id === myId ? myPos() : null;
      if (!pos && snap) { const r = snap.P.find((q) => q[0] === id); if (r) pos = { x: r[1], y: r[2] }; }
      const c = cps[next], d = pos ? Math.hypot(pos.x - c.x, pos.y - c.y) : 1e9;
      out.push({ id, lap, next, key: (lap * N + (next === 0 ? N : next)) * 1e7 - d });
    }
    return out.sort((a, b) => b.key - a.key);
  }
  const ordinal = (n) => n + (['TH', 'ST', 'ND', 'RD'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'TH');
  function raceEvent(e) {
    const k = e[1], rc = rcInfo(), laps = rc ? rc[4] : 3;
    if (k === 0) {
      bigMsg = { txt: 'RACE!', col: '#ffd21f', t: 1.6 };
      midMsg = { txt: (e[2] === myId ? 'YOU' : nm(e[2])) + ' STARTED A RACE · ' + laps + ' LAPS', col: '#fff', t: 3 };
      Audio.announce('race', 'Race on! Two laps!'); Audio.play('fanfare'); race.lastCount = 0; race.boatTold = 0;
    } else if (k === 1) { bigMsg = { txt: 'GO!', col: '#4dff7a', t: 1.2 }; Audio.play('airhorn'); Audio.announce('go', 'Go!'); }
    else if (k === 2 && e[2] === myId) {
      Audio.play('ding'); race.flash = 1;
      const nc = map && map.race && map.race.cps[e[3]];
      if (nc && nc.w && !race.boatTold) { race.boatTold = 1; midMsg = { txt: 'NEXT ONE IS OUT AT SEA: GET A BOAT!', col: '#5adcff', t: 3 }; } // only before the first water checkpoint
    }
    else if (k === 3 && e[2] === myId) {
      Audio.play('ding'); race.flash = 1;
      if (e[3] === laps - 1) { midMsg = { txt: 'FINAL LAP!', col: '#ff7b2b', t: 2.2 }; Audio.announce('lastlap', 'Final lap!'); }
      else midMsg = { txt: 'LAP ' + (e[3] + 1) + ' / ' + laps, col: '#ffd21f', t: 1.8 };
    } else if (k === 4) {
      bigMsg = { txt: e[2] === myId ? 'YOU WIN THE RACE!' : nm(e[2]) + ' WINS THE RACE', col: '#ffd21f', t: 5 };
      if (e[2] === myId) midMsg = { txt: '+2500' + (e[5] ? ` · +${e[5]} FRAG${e[5] > 1 ? 'S' : ''}` : ''), col: '#ffd21f', t: 3 };
      race.champ = { id: e[2], x: e[3], y: e[4], t: 0, pops: 0 };
      Audio.play('fanfare'); Audio.play('cork', e[3], e[4], 1.4); Audio.announce('champ', 'Winner!');
    } else if (k === 5) lowMsg = { txt: 'NOBODY FINISHED: RACE OFF', t: 2.5 };
    else if (k === 7) lowMsg = { txt: 'THE RACE FLAG IS BACK OUT THERE', t: 2.5 };
  }
  // the race flag, checkpoints, the finish line (world space, at street level)
  function drawRaceWorld(t, dt, vis) {
    const rc = rcInfo();
    if (!rc || !map.race || !map.race.cps.length) return;
    const st = rc[0], cps = map.race.cps, f0 = cps[0];
    if (st === 0 && map.race.start && vis(map.race.start.x, map.race.start.y, 120)) {
      const { x, y } = map.race.start, pul = 0.5 + 0.5 * Math.sin(t * 4);
      ctx.strokeStyle = `rgba(255,210,31,${0.35 + 0.4 * pul})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, 30 + 8 * pul, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(x + 6, y + 5, 14, 6, 0, 0, 7); ctx.fill();
      // a chequered flag on a pole, flapping
      const bob = Math.sin(t * 3) * 2;
      ctx.fillStyle = '#ddd'; ctx.fillRect(x - 1.5, y - 30 + bob, 3, 32);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        const wv = Math.sin(t * 7 + i * 0.9) * 2.2;
        ctx.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        ctx.fillRect(x + 1.5 + i * 6, y - 30 + bob + j * 6 + wv * (i / 4), 6, 6);
      }
    }
    if (st >= 1 && st <= 3) {
      // the finish line, straight across the road, with a gantry over it
      const v = f0.v, L = TILE * 2, sq = 8;
      for (let i = 0; i < L / sq; i++) for (let j = 0; j < 3; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
        if (v) ctx.fillRect(f0.x - TILE + i * sq, f0.y - 1.5 * sq + j * sq, sq, sq); else ctx.fillRect(f0.x - 1.5 * sq + j * sq, f0.y - TILE + i * sq, sq, sq);
      }
      // gantry posts at the kerbs and a banner overhead, see-through so the line still shows from above
      ctx.fillStyle = '#555';
      if (v) { ctx.fillRect(f0.x - TILE - 4, f0.y - 3, 6, 6); ctx.fillRect(f0.x + TILE - 2, f0.y - 3, 6, 6); } else { ctx.fillRect(f0.x - 3, f0.y - TILE - 4, 6, 6); ctx.fillRect(f0.x - 3, f0.y + TILE - 2, 6, 6); }
      setWorld(70);
      ctx.globalAlpha = 0.72; ctx.fillStyle = '#c8262a';
      if (v) ctx.fillRect(f0.x - TILE, f0.y - 6, L, 12); else ctx.fillRect(f0.x - 6, f0.y - TILE, 12, L);
      ctx.globalAlpha = 1;
      ctx.save(); ctx.translate(f0.x, f0.y); if (!v) ctx.rotate(Math.PI / 2);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('FINISH', 0, 0.5);
      ctx.restore();
      setWorld(0);
    }
    const mine = myRace();
    if (!mine) return;
    // your next checkpoint glows, the one after it is a faint ring
    const N = cps.length, nx = cps[mine.next], after = cps[(mine.next + 1) % N];
    if (after !== nx && mine.next !== 0) { ctx.strokeStyle = 'rgba(255,210,31,.25)'; ctx.lineWidth = 3; ctx.setLineDash([10, 10]); ctx.beginPath(); ctx.arc(after.x, after.y, 80, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    const pul = 0.5 + 0.5 * Math.sin(t * 6), col = mine.next === 0 ? '255,255,255' : nx.w ? '90,220,255' : '255,210,31';
    if (nx.w) {
      // out at sea: a ring of bobbing red and white buoys
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + t * 0.15, bx = nx.x + Math.cos(a) * 88, by = nx.y + Math.sin(a) * 88, r = 7 + Math.sin(t * 2.5 + i) * 1.2;
        ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(bx, by, r + 4 + 2 * Math.sin(t * 3 + i), 0, 7); ctx.fill();
        ctx.fillStyle = i % 2 ? '#f4f4f4' : '#e0262a'; ctx.beginPath(); ctx.arc(bx, by, r, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    const gr = ctx.createRadialGradient(nx.x, nx.y, 20, nx.x, nx.y, 95);
    gr.addColorStop(0, `rgba(${col},0)`); gr.addColorStop(0.8, `rgba(${col},${0.12 + 0.1 * pul})`); gr.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(nx.x, nx.y, 95, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(${col},${0.6 + 0.4 * pul})`; ctx.lineWidth = 5; ctx.setLineDash([18, 12]); ctx.lineDashOffset = -t * 40;
    ctx.beginPath(); ctx.arc(nx.x, nx.y, 80, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    ctx.fillStyle = `rgba(${col},.9)`; ctx.font = 'bold 26px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(mine.next === 0 ? '🏁' : nx.w ? '🚤' + mine.next : String(mine.next), nx.x, nx.y);
  }
  // champagne: the winner sprays it around for a few seconds
  function stepChampagne(dt) {
    const c = race.champ;
    if (!c) return;
    c.t += dt;
    if (c.t > 7) { race.champ = null; return; }
    let x = c.x, y = c.y;
    if (c.id === myId) { const p = myPos(); if (p) { x = p.x; y = p.y; } }
    else { const sn = snaps[snaps.length - 1], r = sn && sn.P.find((q) => q[0] === c.id); if (r) { x = r[1]; y = r[2]; } }
    if (c.t > 0.3 && c.t < 6) {
      const dir = c.t * 2.2, n = Math.round(dt * 260);
      for (let i = 0; i < n; i++) {
        const a = dir + rnd(-0.35, 0.35), sp = rnd(90, 260);
        addP({ t: 'champ', x, y, z: 14, vz: rnd(160, 330), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.6, 1.1), max: 1.1, sz: rnd(1.6, 3.2), gold: Math.random() < 0.6 }, true);
      }
      if (Math.random() < dt * 30) addP({ t: 'foam', x: x + rnd(-10, 10), y: y + rnd(-10, 10), vx: rnd(-20, 20), vy: rnd(-20, 20), life: rnd(0.8, 1.6), max: 1.6, sz: rnd(4, 9) }, true);
      if (Math.random() < dt * 4) Audio.play('fizz', x, y, 0.8);
    }
    if (c.t < 1.2 && Math.random() < dt * 40) {
      const a = rnd(0, 7), sp = rnd(60, 220);
      addP({ t: 'confetti', x, y, z: 30, vz: rnd(120, 300), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(1.4, 2.4), max: 2.4, rot: rnd(0, 7), col: ['#ffd21f', '#e3262c', '#3d7bff', '#4dff7a', '#fff'][Math.floor(rnd(0, 5))] }, true);
    }
  }
  // the race panel and the arrow to your next checkpoint (screen space)
  // who's winning: every racer in order, with their lap and how many checkpoints they've done, down the left side
  function drawRaceTable(u, pad, st, laps, N) {
    if (st !== 1 && st !== 2 && st !== 3) return;
    const all = raceStandings(), rc = rcInfo();
    if (!all.length) return;
    const rows = all.slice(0, 8), rh = 22 * u, w = 214 * u, x0 = pad, y0 = H * 0.26;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x0, y0, w, rh * (rows.length + 1) + 8 * u);
    ctx.fillStyle = '#ffd21f'; ctx.fillRect(x0, y0, 4 * u, rh * (rows.length + 1) + 8 * u);
    txt(st === 3 ? 'RACE RESULT' : 'RACE', x0 + 12 * u, y0 + rh * 0.62, 14 * u, '#ffd21f', 'left');
    rows.forEach((r, i) => {
      const y = y0 + rh * (i + 1.62) + 2 * u, me = r.id === myId, win = st === 3 && rc && rc[2] === r.id;
      if (me) { ctx.fillStyle = 'rgba(255,210,31,.18)'; ctx.fillRect(x0 + 4 * u, y - rh * 0.68, w - 4 * u, rh); }
      txt(String(i + 1), x0 + 22 * u, y, 14 * u, i === 0 ? '#ffd21f' : '#fff', 'right');
      ctx.fillStyle = nc(r.id); ctx.fillRect(x0 + 30 * u, y - 10 * u, 8 * u, 12 * u);
      const name = (me ? 'YOU' : nm(r.id).toUpperCase()).slice(0, 12);
      txt((win ? '★ ' : '') + name, x0 + 44 * u, y, 13 * u, me ? '#ffd21f' : '#fff', 'left');
      const done = r.next === 0 ? N - 1 : r.next - 1;
      txt(r.lap >= laps ? 'DONE' : `L${Math.min(laps, r.lap + 1)} · ${done}/${N - 1}`, x0 + w - 8 * u, y, 12 * u, '#bbb', 'right');
    });
    if (all.length > rows.length) txt(`+${all.length - rows.length} more`, x0 + 12 * u, y0 + rh * (rows.length + 1.7), 11 * u, '#999', 'left');
  }
  function drawBrawlHud(u, pad) {
    if (!myBrawl || !me || !me.al) return;
    const b = myBrawl, standing = [...b.m.values()].filter((m) => m.st !== BST.KO).length;
    const line = `STREET BRAWL   ·   ${standing} STANDING   ·   ${Math.floor(b.left / 60)}:${String(b.left % 60).padStart(2, '0')}`;
    const y0 = pad + 112 * u;
    ctx.font = `bold ${17 * u}px system-ui, sans-serif`;
    const w = ctx.measureText(line).width + 28 * u;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(W / 2 - w / 2, y0 - 16 * u, w, 32 * u);
    ctx.fillStyle = '#ffd21f'; ctx.fillRect(W / 2 - w / 2, y0 + 14 * u, w, 3 * u);
    txt(line, W / 2, y0, 17 * u, '#ffd21f', 'center');
    // everyone in the ring, with their health
    let x = W / 2 - (b.m.size * 120 * u) / 2;
    for (const [pid, m] of b.m) {
      const f = clamp(m.hp / 100, 0, 1), out = m.st === BST.KO;
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(x + 4 * u, y0 + 24 * u, 112 * u, 22 * u);
      ctx.fillStyle = out ? '#555' : nc(pid); ctx.fillRect(x + 4 * u, y0 + 40 * u, 112 * u * f, 5 * u);
      txt((pid === myId ? 'YOU' : nm(pid).replace('[BOT] ', '')).slice(0, 12) + (out ? ' · OUT' : ''), x + 60 * u, y0 + 32 * u, 11 * u, out ? '#999' : '#fff', 'center');
      x += 120 * u;
    }
  }
  function drawRaceHud(dt, u, pad) {
    const rc = rcInfo();
    if (!rc || !map || !map.race) return;
    const st = rc[0], cps = map.race.cps, laps = rc[4];
    if (st === 1) {
      const n = rc[1] >= 4 ? 0 : rc[1];
      if (n !== race.lastCount) {
        race.lastCount = n;
        if (n >= 1 && n <= 3) { bigMsg = { txt: String(n), col: '#fff', t: 0.9 }; Audio.play('beep'); Audio.announce(['', 'one', 'two', 'three'][n], String(n)); }
      }
    }
    drawRaceTable(u, pad, st, laps, cps.length);
    const mine = myRace();
    if (!mine) return;
    race.flash = Math.max(0, race.flash - dt * 2);
    const all = raceStandings(), place = all.findIndex((r) => r.id === myId) + 1;
    const N = cps.length, done = mine.next === 0 ? N - 1 : mine.next - 1;
    const line = `LAP ${Math.min(laps, mine.lap + 1)}/${laps}   ·   CHECKPOINT ${done}/${N - 1}${mine.next === 0 ? '  →  FINISH' : cps[mine.next].w ? '  →  BOATS ONLY' : ''}   ·   ${ordinal(place)} OF ${all.length}`;
    const y0 = pad + 112 * u;
    ctx.fillStyle = `rgba(0,0,0,${0.5 + 0.3 * race.flash})`;
    ctx.font = `bold ${17 * u}px system-ui, sans-serif`;
    const w = ctx.measureText(line).width + 28 * u;
    ctx.fillRect(W / 2 - w / 2, y0 - 16 * u, w, 32 * u);
    txt(line, W / 2, y0, 17 * u, race.flash > 0.1 ? '#fff' : '#ffd21f', 'center');
    if (st === 1) return;
    // the arrow: hovers over you and points at the next checkpoint
    const p = myPos();
    if (!p) return;
    const c = cps[mine.next], d = Math.hypot(c.x - p.x, c.y - p.y), ang = Math.atan2(c.y - p.y, c.x - p.x);
    const [sx, sy] = proj(p.x, p.y, 0), R = 70 * cam.ppu, bob = Math.sin(performance.now() / 160) * 3 * u;
    ctx.save(); ctx.translate(sx + Math.cos(ang) * (R + bob), sy + Math.sin(ang) * (R + bob)); ctx.rotate(ang);
    const s = 1.8 * u * (d < 150 ? 0.8 : 1);
    ctx.fillStyle = mine.next === 0 ? '#ffffff' : c.w ? '#5adcff' : '#ffd21f'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3 * u;
    ctx.beginPath(); ctx.moveTo(18 * s, 0); ctx.lineTo(-6 * s, -14 * s); ctx.lineTo(-1 * s, 0); ctx.lineTo(-6 * s, 14 * s); ctx.closePath(); ctx.stroke(); ctx.fill();
    ctx.restore();
    txt(Math.round(d / 10) + ' m', sx + Math.cos(ang) * (R + 44 * u), sy + Math.sin(ang) * (R + 44 * u) + 2 * u, 13 * u, '#fff', 'center', 2);
  }

  // ================================================================ events
  const feed = [], chat = [];
  let bigMsg = null, midMsg = null, lowMsg = null, radioMsg = null;
  const VERB = { 52: 'won a fist fight against', 53: 'performed a FATALITY on', 25: 'pushed off a roof', 40: 'beat down', 0: 'shot', 1: 'popped', 2: 'riddled', 3: 'blasted', 4: 'fried', 5: 'toasted', 6: 'rocketed', 7: 'fragged', 8: 'torched', 20: 'flattened', 21: 'blew up', 22: 'roasted', 24: 'blew up', 30: 'gunned down' };
  const SELF = { 54: 'was finished off by the police', 26: 'got hit by traffic', 50: 'got busted', 51: 'was gunned down by the police', 25: 'fell off a roof', 21: 'blew themselves up', 22: 'burned to a crisp', 23: 'drowned', 24: 'went up with their car', 20: 'got run over' };
  const nm = (id) => (id < 0 ? 'OFFICER' : (roster.get(id) || { name: '?' }).name); // negative id: a cop (in a fist fight)
  const nc = (id) => (id < 0 ? '#1d2b6b' : (roster.get(id) || { color: '#fff' }).color);
  let deathCam = null;
  const lastSfx = {};
  function sfxT(name, x, y, gap, vol) { const n = performance.now(); if (lastSfx[name] && n - lastSfx[name] < gap) return; lastSfx[name] = n; Audio.play(name, x, y, vol); }
  const voiceOf = (id) => id * 7 + 3;
  function pedNear(s, x, y, r = 24) {
    let best = 0, bd = r;
    for (const p of s.P) { if (p[6]) continue; const d = Math.hypot(p[1] - x, p[2] - y); if (d < bd) { bd = d; best = p[0]; } }
    for (const n of s.N || []) { const d = Math.hypot(n[1] - x, n[2] - y); if (d < bd) { bd = d; best = n[4] & 1 ? -n[0] : n[0]; } }
    return best;
  }
  const lastHurt = new Map();
  function hurt(s, x, y) {
    const id = pedNear(s, x, y), n = performance.now();
    if (!id || n - (lastHurt.get(id) || 0) < 650) return;
    lastHurt.set(id, n);
    if (id < 0) Audio.cop('hurt', x, y); else Audio.voice(voiceOf(id), 'hurt', x, y, 0.9);
  }
  function carPos(s, id) { const r = s.Cm.get(id); return r ? [r[3], r[4]] : null; }
  function handleEvent(e, s) {
    switch (e[0]) {
      case 's': {
        let [, x, y, ex, ey, kind, w, by] = e;
        const mine = by === myId && w <= 3; // already flashed and banged when you pressed fire
        let onBoat = null;
        if (w === 30) {
          // a boat's twin guns: start the tracer at the barrel it came from, on the boat as it's drawn right now
          let bd2 = 140, now = performance.now();
          for (const [cid, v] of turretSeen) { if (now - v.at > 500) { turretSeen.delete(cid); continue; } if (v.t !== 'boat') continue; const d = Math.hypot(v.x - x, v.y - y); if (d < bd2) { bd2 = d; onBoat = v; } }
        }
        if (onBoat) {
          const ms = boatMuzzles(onBoat); onBoat.bar = onBoat.bar ? 0 : 1; const m = ms[onBoat.bar]; // the two guns take turns, as in the game
          const dx = m[0] - x, dy = m[1] - y; if (!kind) { ex += dx; ey += dy; } x = m[0]; y = m[1];
        } else if (by === myId && w === 30 && pred.mode === 'car' && pred.c) {
          // your car's gun: the game fired it from where your car was then; move it onto the car as it's drawn
          const C = S.CARS[pred.c.t], cx = pred.c.x + off.x, cy = pred.c.y + off.y, ca = Math.cos(pred.c.a + off.a), sa = Math.sin(pred.c.a + off.a);
          let bx = x, by2 = y, bd = 1e9;
          for (const side of [-1, 1]) {
            const lx = C.len / 2 + 4, ly = side * (C.wid / 2 - 4), mx = cx + lx * ca - ly * sa, my = cy + lx * sa + ly * ca;
            const d = Math.hypot(mx - x, my - y);
            if (d < bd) { bd = d; bx = mx; by2 = my; }
          }
          if (bd < 160) { const dx = bx - x, dy = by2 - y; if (!kind) { ex += dx; ey += dy; } x = bx; y = by2; }
        }
        if (!mine) {
          tracers.push({ x1: x, y1: y, x2: ex, y2: ey, life: 0.07, max: 0.07, w: w === 3 ? 1 : 1.6 });
          addP({ t: 'muzzle', x, y, a: Math.atan2(ey - y, ex - x), life: 0.07, max: 0.07 });
          pulse(x, y, w === 3 ? 130 : 95, '255,205,130', 0.09);
          sfxT(w === 3 ? 'shotgun' : w === 30 ? 'hmg' : w === 2 ? 'mg' : 'pistol', x, y, w === 3 ? 60 : 25);
        }
        if (kind === 1) { blood(ex, ey, 6, false); hurt(s, ex, ey); }
        else if (kind >= 2) sparks(ex, ey, 4);
        break;
      }
      case 'u':
        Audio.play(e[3] ? 'punch' : e[4] === myId ? 'none' : 'whoosh', e[1], e[2]);
        if (e[3]) { blood(e[1], e[2], 3, false); hurt(s, e[1], e[2]); }
        if (e[4] && e[4] !== myId) startPunch(e[4]); // your own punches animate the moment you press
        break;
      case 'z': zaps.push({ pts: e.slice(1), life: 0.09 }); sfxT('zap', e[1], e[2], 70); pulse(e[1], e[2], 130, '120,170,255', 0.12); break;
      case 'f': {
        const [, x, y, a] = e;
        // a tight jet that spreads as it goes: most of it straight down the line, a little wider
        for (let i = 0; i < 6; i++) { const aa = a + rnd(-0.1, 0.1) * (i < 4 ? 1 : 2), sp = rnd(340, 480), off = rnd(0, 8); addP({ t: 'flame', x: x + Math.cos(a) * off, y: y + Math.sin(a) * off, vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp, life: rnd(0.36, 0.5), max: 0.5, sz: rnd(2.5, 4) }); }
        if (Math.random() < 0.35) { const aa = a + rnd(-0.2, 0.2); addP({ t: 'smoke', x: x + Math.cos(a) * 150, y: y + Math.sin(a) * 150, vx: Math.cos(aa) * 40, vy: Math.sin(aa) * 40, life: rnd(0.6, 1), max: 1, sz: rnd(6, 10), dark: 0.6 }); }
        sfxT('flame', x, y, 90);
        pulse(x, y, 120, '255,140,50', 0.1);
        break;
      }
      case 'x': {
        let [, x, y, R, z] = e;
        if (z > 1) { const f = cam.h / (cam.h - Math.min(400, z)); x = cam.x + (x - cam.x) * f; y = cam.y + (y - cam.y) * f; } // up in the air: where it shows on screen
        explosionFx(x, y, R);
        pulse(x, y, R * 3.4, '255,170,80', 0.8);
        Audio.play('boom', x, y);
        const d = Math.hypot(x - cam.x, y - cam.y);
        shake = Math.max(shake, 22 * clamp(1 - d / 1100, 0, 1));
        break;
      }
      case 'r': Audio.play('rocket', e[1], e[2]); break;
      case 'fo': { const [, a, b, mode, menu] = e; if (a === myId) showOffer(b, mode, menu ? 'wait' : ''); else if (b === myId) showOffer(a, mode, menu ? 'asked' : ''); break; }
      case 'fy': { const [, by, other] = e; if (other === myId && offer && offer.other === by) { lowMsg = { txt: `${nm(by).toUpperCase()} WANTS A FIGHT`, t: 2.5 }; hideOffer(); } else if (by === myId) hideOffer(); break; }
      case 'fn': {
        const [, by, other] = e;
        if (by === 0 && other === myId) { lowMsg = { txt: 'NOBODY FREE TO FIGHT RIGHT NOW (OR NO CAR TO FIGHT OVER)', t: 3 }; break; }
        if (offer && (by === myId || other === myId)) { if (by !== myId) lowMsg = { txt: `${nm(by).toUpperCase()} WALKED AWAY`, t: 2.5 }; hideOffer(); }
        break;
      }
      case 'du': {
        hideOffer();
        // two players fighting over a car
        const [, , a, b] = e;
        feed.push({ txt: `${nm(a)} and ${nm(b)} are fighting over a car!`, kc: nc(a), vc: nc(b), t: 6, kid: a, vid: b });
        if (feed.length > 6) feed.shift();
        break;
      }
      case 'tn': { // a burp, a fart or a taunt (Tab)
        const [, pid, kind, v] = e, an = pedAnim.get(pid), row = s.Pm && s.Pm.get(pid);
        let x = an ? an.x : row ? row[1] : cam.x, y = an ? an.y : row ? row[2] : cam.y;
        if (row && row[6]) { const cp = carPos(s, row[6]); if (cp) { x = cp[0]; y = cp[1]; } }
        if (kind === 0) Audio.burp(x, y, v); else if (kind === 1) Audio.fart(x, y, v); else Audio.voice(voiceOf(pid), 'taunt', x, y, 1.1);
        const L = kind === 0 ? ['*BUUUURP*', '*BRAAAP*', '*urrrp*'] : kind === 1 ? ['*PFFFRT*', '*BRRRAPP*', '*fffft...*', '*PARP*'] : ['COME AT ME!', 'IS THAT ALL?', 'TOO SLOW!', 'NICE CAR. MINE NOW.', 'CRY ABOUT IT!', 'YOU DRIVE LIKE MY NAN!', 'GET WRECKED!', 'WHO WANTS SOME?'];
        says.set(pid, { txt: L[v % L.length], t: 0, kind, x, y });
        if (kind === 1 && Math.hypot(x - cam.x, y - cam.y) < 900) for (let i = 0; i < 5; i++) addP({ t: 'smoke', x: x + rnd(-4, 4), y: y + rnd(-4, 4), vx: rnd(-14, 14), vy: rnd(-14, 14), life: 1.1, max: 1.1, sz: 3, dark: 0, col: 'rgba(150,175,60,' });
        break;
      }
      // ---- street brawls
      case 'bs': { // a one-on-one spilled out into the street
        const [, , x, y, , did] = e;
        if (Math.hypot(x - cam.x, y - cam.y) < 900) { midMsg = { txt: 'STREET BRAWL!', col: '#ffd21f', t: 2.4 }; Audio.play('crash', x, y, 0.6); }
        if (fight.id === did) { fight.last = null; } // that fight screen closes at once
        break;
      }
      case 'bj': {
        const [, bid, pid] = e, b = brawlMap.get(bid);
        if (pid === myId) { bigMsg = { txt: 'BRAWL!', col: '#ffd21f', t: 1.4 }; Audio.announce('fight', 'Fight!'); lowMsg = { txt: 'A PUNCH · Z KICK · S BLOCK · X THROW · STAND STILL TO FACE THEM', t: 7 }; }
        else if (b && b.m.has(myId)) midMsg = { txt: nm(pid) + ' JUMPS IN!', col: nc(pid), t: 1.8 };
        break;
      }
      case 'bp': if (e[1] !== myId) startPunch(e[1]); if (!e[2]) { const p2 = pedAnim.get(e[1]); if (p2 && e[1] !== myId) Audio.play('whoosh', p2.x, p2.y, 0.6); } break;
      case 'bk': if (e[1] !== myId) { startKick(e[1]); const p2 = pedAnim.get(e[1]); if (p2) Audio.play('whoosh', p2.x, p2.y, 0.9); } break;
      case 'bt': { startGrab(e[1]); if (e[2]) { Audio.play('throw', e[3], e[4]); Audio.play('whoosh', e[3], e[4], 1.2); } break; }
      case 'bh': {
        const [, tid, dmg, blocked, x, y, kind, floor, aid] = e;
        if (blocked === 2) { Audio.play('whoosh', x, y, 0.7); dmgTexts.push({ x, y: y - 14, txt: 'MISSED', col: '#9fe0ff', t: 0 }); break; } // they'd broken free: nothing lands
        if (blocked) { Audio.play('clunk', x, y, 0.6); addP({ t: 'spark', x, y, vx: 0, vy: 0, life: 0.15, max: 0.15, sz: 4 }); }
        else {
          Audio.play(kind === 1 && !floor ? 'punch' : 'crash', x, y, kind === 1 && !floor ? 1 : 0.55); if (floor) Audio.play('punch', x, y, 1.2);
          blood(x, y, floor ? 8 : 3, false); hurt(s, x, y);
          if (tid === myId || aid === myId) shake = Math.max(shake, floor ? 9 : 4);
        }
        dmgTexts.push({ x: x + rnd(-6, 6), y: y - 14, txt: blocked ? 'BLOCK' : String(dmg), col: blocked ? '#9fe0ff' : floor ? '#ff7b2b' : '#fff', t: 0 });
        break;
      }
      case 'bx': { // broke free of a run of hits: a flash, and a moment where nothing lands
        const [, pid, x, y] = e;
        dmgTexts.push({ x, y: y - 22, txt: 'BREAK FREE!', col: '#ffd21f', t: 0 });
        brawlFlash.set(pid, 0); Audio.play('whoosh', x, y, 1.3);
        break;
      }
      case 'bl': Audio.play('land', e[2], e[3], 1); for (let i = 0; i < 6; i++) addP({ t: 'smoke', x: e[2] + rnd(-8, 8), y: e[3] + rnd(-8, 8), vx: rnd(-30, 30), vy: rnd(-30, 30), life: 0.5, max: 0.5, sz: 4, dark: 0.1 }); shake = Math.max(shake, 3); break;
      case 'bd': { const [, cid, x, y, n] = e; Audio.play('crash', x, y, 1); carDents.set(cid, (carDents.get(cid) || []).concat([{ x, y, n }]).slice(-8)); shake = Math.max(shake, 5); for (let i = 0; i < 8; i++) addP({ t: 'spark', x, y, vx: rnd(-120, 120), vy: rnd(-120, 120), life: 0.25, max: 0.25, sz: 2 }); break; }
      case 'bko': {
        const [, vid, aid] = e;
        if (vid === myId) bigMsg = { txt: 'K.O.', col: '#ff3b3b', t: 2 };
        else if (aid === myId) { midMsg = { txt: 'YOU KNOCKED OUT ' + nm(vid) + '!', col: '#ffd21f', t: 2 }; Audio.announce('brutal', 'Brutal!'); }
        else if (myBrawl) midMsg = { txt: nm(vid) + ' IS OUT', col: '#fff', t: 1.6 };
        break;
      }
      case 'be': {
        const [, , w] = e;
        if (w === myId) { bigMsg = { txt: 'LAST ONE STANDING!', col: '#ffd21f', t: 2.4 }; Audio.announce('victory', 'Victory!'); setTimeout(() => { midMsg = { txt: 'YOU WON THE CAR!', col: '#ffd21f', t: 2 }; }, 900); }
        else if (w && myBrawl) midMsg = { txt: nm(w) + ' WINS THE BRAWL', col: nc(w), t: 2.4 };
        break;
      }
      case 'de': {
        const [, , w, l, fk] = e;
        if (fk) { feed.push({ txt: `${nm(w)}: ${S.Fight.FATALS[fk]} FATALITY on ${nm(l)}`, kc: nc(w), vc: nc(l), t: 7, kid: w, vid: l }); if (feed.length > 6) feed.shift(); }
        if (w === myId) setTimeout(() => { midMsg = { txt: 'YOU WON THE CAR!', col: '#ffd21f', t: 2 }; }, 300);
        break;
      }
      case 't': Audio.play('throw', e[1], e[2]); break;
      case 'm': pulse(e[1], e[2], 170, '255,140,50', 0.7); Audio.play('glass', e[1], e[2]); for (let i = 0; i < 14; i++) fireP(e[1] + rnd(-30, 30), e[2] + rnd(-30, 30), 10); break;
      case 'k': {
        const [, vid, kid, cause, x, y, a] = e;
        const txt = kid ? `${nm(kid)} ${VERB[cause] || 'wasted'} ${nm(vid)}` : `${nm(vid)} ${SELF[cause] || 'died'}`;
        if (cause !== 53) { feed.push({ txt, kc: kid ? nc(kid) : nc(vid), vc: nc(vid), t: 6, kid, vid, cause }); if (feed.length > 6) feed.shift(); } // a fatality has its own line
        if (cause !== 23 && cause !== 24 && cause !== 50) {
          blood(x, y, cause === 20 ? 22 : 10, true);
          falls.push({ x, y, a, col: nc(vid), t: vid === myId ? 0 : -INTERP / 1000 });
          pools.push({ x: x + rnd(-4, 4), y: y + rnd(-4, 4), r: rnd(12, 19), rot: rnd(0, 3), t: -0.3 });
        }
        if (cause === 20) Audio.play('splat', x, y);
        if (cause !== 23 && cause !== 50) Audio.voice(voiceOf(vid), 'die', x, y);
        if (kid && kid !== vid && Math.random() < 0.35) {
          const kr = s.Pm.get(kid);
          if (kr) setTimeout(() => Audio.voice(voiceOf(kid), 'taunt', kr[1], kr[2], 0.9), 700);
        }
        if (vid === myId && cause === 50) { bigMsg = { txt: 'BUSTED!', col: '#4f8dff', t: 3.2 }; deathCam = { x, y }; Audio.play('wasted'); Audio.announce('busted', 'Busted!'); }
        else if (vid === myId) { bigMsg = { txt: 'WASTED!', col: '#e3262c', t: 3.2 }; deathCam = { x, y }; Audio.play('wasted'); Audio.announce('wasted', 'Wasted!'); }
        else if (kid === myId) { midMsg = { txt: cause === 20 ? 'ROADKILL! +1' : 'FRAG! +1', col: '#ffd21f', t: 1.6 }; Audio.announce(cause === 20 ? 'roadkill' : 'frag', cause === 20 ? 'Road kill!' : 'Frag!'); }
        break;
      }
      case 'pk': {
        // a pedestrian or cop goes down
        const [, id, x, y, a, cause, kid, kind, pts] = e;
        const lag = kid === myId ? 0 : -INTERP / 1000;
        if (cause !== 23) {
          blood(x, y, cause === 20 ? 22 : 9, true);
          falls.push({ x, y, a, col: kind === 1 ? '#1d2b6b' : kind === 2 ? GANG_COL : PED_COLS[id % PED_COLS.length], t: lag });
          pools.push({ x: x + rnd(-4, 4), y: y + rnd(-4, 4), r: rnd(11, 17), rot: rnd(0, 3), t: lag - 0.3 });
        }
        if (cause === 20) Audio.play('splat', x, y);
        if (kind === 1) Audio.cop('hurt', x, y); else Audio.voice(voiceOf(id), 'die', x, y);
        if (kid === myId && pts) popups.push({ x, y, txt: '+' + pts, t: 0, col: kind === 1 ? '#7fb2ff' : '#ffd21f' });
        if (kind === 1 && kid) { feed.push({ txt: `${nm(kid)} took out a cop`, t: 6, kid, vid: 0 }); if (feed.length > 6) feed.shift(); }
        if (kind === 2 && e[9] === myId) lowMsg = { txt: 'ONE OF YOUR CREW IS DOWN', t: 2.2 };
        break;
      }
      case 'ws': { // a fire truck's water cannon
        const p = carPos(s, e[1]); if (!p) break;
        const a = e[2], C = S.CARS[S.FIRE], ca0 = p[2] ?? a, ox = p[0] + Math.cos(ca0) * (C.len / 2 - 30) + Math.cos(a) * 12, oy = p[1] + Math.sin(ca0) * (C.len / 2 - 30) + Math.sin(a) * 12; // out of the turret's nozzle
        for (let i = 0; i < 8; i++) { const aa = a + rnd(-0.07, 0.07), sp = rnd(380, 560), f0 = rnd(0, 0.1); addP({ t: 'smoke', x: ox + Math.cos(aa) * sp * f0, y: oy + Math.sin(aa) * sp * f0, vx: Math.cos(aa) * sp, vy: Math.sin(aa) * sp, life: rnd(0.3, 0.42), max: 0.42, sz: rnd(4, 7), dark: 0, col: i & 1 ? 'rgba(225,245,255,1)' : 'rgba(120,190,255,1)' }); }
        sfxT('fizz', ox, oy, 260);
        break;
      }
      case 'xo': { const p = carPos(s, e[1]); if (p) { for (let i = 0; i < 14; i++) smoke(p[0] + rnd(-16, 16), p[1] + rnd(-10, 10), 12, 0.6); Audio.play('fizz', p[0], p[1], 1.2); } break; } // put out
      case 'tk': { const p = carPos(s, e[1]); if (p) { Audio.play('boom', p[0], p[1], 0.7); shake = Math.max(shake, 4); } break; } // the tank's cannon
      case 'cm': { // a gang member joins your crew
        const [, nid, by, n] = e;
        if (by === myId) { lowMsg = { txt: `GANG MEMBER IN · CREW ${n}/3`, t: 2.4 }; Audio.play('pickup'); crewHintDone = true; }
        const r = s && s.N && s.N.find((q) => q[0] === nid);
        if (r) Audio.voice(voiceOf(nid), 'jack', r[1], r[2], 0.8);
        break;
      }
      case 'cl': break; // one went back to the street
      case 'cb': break; // climbed into the car
      case 'pa': {
        const n = performance.now();
        if (n - (lastSfx.panic || 0) > 350) { lastSfx.panic = n; Audio.voice(voiceOf(e[1]), 'panic', e[2], e[3], 0.75); }
        break;
      }
      case 'cv': Audio.cop(['spot', 'arrest', 'lost', 'hurt'][e[2]] || 'spot', e[3], e[4]); break;
      case 'sp': if (e[1] === myId) { deathCam = null; lowMsg = { txt: S.district(map, cam.x, cam.y), t: 3 }; } break;
      case 'e': {
        const pid = e[1], cid = e[2] || lastCar.get(pid), cr = cid ? s.Cm.get(cid) : null;
        // others are drawn a little in the past (interpolation), so their animations start a little later
        const lag = pid === myId ? 0 : -INTERP / 1000;
        if (cr) {
          const C = S.CARS[cr[1]], ca = Math.cos(cr[5]), sa = Math.sin(cr[5]);
          const lx = C.len * 0.05, ly = -(C.wid / 2 + 7);
          const dx = cr[3] + ca * lx - sa * ly, dy = cr[4] + sa * lx + ca * ly;
          doorAnim.set(cid, { t: lag });
          if (e[2]) {
            const an = pedAnim.get(pid);
            if (an && Math.hypot(an.x - dx, an.y - dy) < 120) ghosts.push({ x0: an.x, y0: an.y, dx, dy, x1: cr[3], y1: cr[4], col: nc(pid), t: lag });
          } else {
            const pr = s.Pm.get(pid);
            if (pr) { let an = pedAnim.get(pid); if (!an) { an = newPedAnim(pr[1], pr[2]); pedAnim.set(pid, an); } an.ox = dx - pr[1]; an.oy = dy - pr[2]; an.ot = 0; }
          }
          Audio.play('door', cr[3], cr[4], 0.6);
        }
        if (pid === myId && e[2] && cr) {
          const ups = S.UP_NAMES.filter(([b]) => (cr[11] || 0) & b).map(([, n]) => n);
          lowMsg = { txt: [S.CARS[cr[1]].name, ...ups].join(' + '), t: ups.length ? 3.2 : 2.5 };
        }
        break;
      }
      case 'j': {
        const jr = s.Pm.get(e[1]), vr = s.Pm.get(e[2]);
        if (jr) Audio.voice(voiceOf(e[1]), 'jack', jr[1], jr[2]);
        if (vr) setTimeout(() => Audio.voice(voiceOf(e[2]), 'jacked', vr[1], vr[2]), 450);
        if (e[2] === myId) midMsg = { txt: 'CARJACKED!', col: '#ff7b2b', t: 1.8 };
        else if (e[1] === myId) { midMsg = { txt: 'CARJACKING! +100', col: '#ffd21f', t: 1.5 }; Audio.announce('carjacking', 'Car jacking!'); }
        break;
      }
      case 'p': {
        const pk = null;
        if (e[1] === myId) { lowMsg = { txt: S.pickupName(e[2]), t: 2.2 }; Audio.play('pickup'); Audio.announce(String(e[2]), S.pickupName(e[2])); }
        break;
      }
      case 'sh': {
        // through a chop shop: a cloud of the new paint, and for you the news
        const [, cid, si, col, k, by] = e, sh = map.shops && map.shops[si];
        if (sh) {
          const pc = S.CAR_COLORS[col] || '#fff';
          for (let i = 0; i < 26; i++) { const a = rnd(0, 7), sp = rnd(20, 90); addP({ t: 'smoke', x: sh.x + rnd(-14, 14), y: sh.y + rnd(-14, 14), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.6, 1.3), max: 1.3, sz: rnd(6, 12), dark: 0, col: pc }, true); }
          Audio.play('spray', sh.x, sh.y);
        }
        if (by === myId) {
          midMsg = { txt: 'CHOP SHOP! FRESH PAINT + ' + S.CARWEAPONS[k].name, col: '#ff5fc8', t: 2.6 };
          lowMsg = { txt: 'THE POLICE LOST YOUR DESCRIPTION', t: 2.4 };
          Audio.play('pickup'); Audio.announce(String(30 + k), S.CARWEAPONS[k].name);
        }
        break;
      }
      case 'bo': { // someone changed the bots from the menu
        const [, n, k, by] = e, who = roster.get(by);
        game.bn = n; game.bs = k;
        lowMsg = { txt: `${who && by !== myId ? who.name.toUpperCase() + ': ' : ''}BOTS ${n} · SKILL ${S.BOT_SKILLS[k]}`, t: 2.2 };
        break;
      }
      case 'cf': { const p = carPos(s, e[1]); if (p) Audio.play('ignite', p[0], p[1]); break; }
      case 'pc': { if (e[1] === myId) midMsg = { txt: 'PARACHUTE!  ↑ GLIDE · ← → STEER', col: '#7fe6ff', t: 2.2 }; Audio.play('whoosh', cam.x, cam.y, 0.8); break; } // someone bailed out of a helicopter
      case 'ro': { const p = carPos(s, e[2]); if (p) { Audio.play('clunk', p[0], p[1], 0.7); Audio.play('land', p[0], p[1], 0.5); } break; } // out onto another car's roof
      case 'cr': {
        // a car came down on another one
        const [, , x, y, by] = e;
        Audio.play('crash', x, y, 1.4); Audio.play('glass', x, y); sparks(x, y, 18); shake = Math.max(shake, 8);
        for (let i = 0; i < 8; i++) smoke(x + rnd(-14, 14), y + rnd(-14, 14), 10, 0.6);
        if (by === myId) { midMsg = { txt: 'CRUSHED!', col: '#ffd21f', t: 1.4 }; popups.push({ x, y, txt: 'CRUSHED!', t: 0, col: '#ff9b2b' }); }
        break;
      }
      case 'hc': {
        Audio.play('boom', e[2], e[3], 0.5);
        if (pred.mode === 'car' && pred.id === e[1]) { bigMsg = { txt: 'MAYDAY!', col: '#ff7b2b', t: 2.2 }; shake = Math.max(shake, 10); }
        break;
      }
      case 'hu': if (e[1] === myId) { midMsg = { txt: 'HEALTH UP! +25', col: '#7dff8a', t: 1.8 }; Audio.play('pickup'); } break;
      case 'tb': if (e[3] !== myId) Audio.play('boing', e[1], e[2]); break;
      case 'cj': if (!(pred.mode === 'car' && pred.id === e[1])) { Audio.play('jump', e[2], e[3], 1.3); Audio.play('whoosh', e[2], e[3]); } break;
      case 'w': for (let i = 0; i < 20; i++) { const a = rnd(0, 7), sp = rnd(40, 160); addP({ t: 'water', x: e[1], y: e[2], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(0.3, 0.7), max: 0.7 }); } Audio.play('splash', e[1], e[2]); break;
      case 'h': {
        const p = carPos(s, e[1]), n = performance.now();
        if (p && !(lastSfx['h' + e[1]] && n - lastSfx['h' + e[1]] < 350)) { lastSfx['h' + e[1]] = n; Audio.play('horn', p[0], p[1]); }
        break;
      }
      case 'b': sparks(e[1], e[2], 8, '#fff'); Audio.play('crash', e[1], e[2], clamp(e[3] / 400, 0.3, 1)); break;
      case 'd': Audio.play('clunk', e[1], e[2]); break;
      case 'ra': raceEvent(e); break;
      case 'o': bigMsg = { txt: e[1] === myId ? 'YOU WIN!' : nm(e[1]) + ' WINS', col: '#ffd21f', t: 9.5 }; Audio.play('fanfare'); if (e[1] === myId) Audio.announce('win', 'Winner!'); break;
      case 'n': midMsg = { txt: 'NEW MATCH - GO!', col: '#ffd21f', t: 2.5 }; feed.length = 0; Audio.announce('newmatch', 'New match. Go!'); break;
      case 'c': chat.push({ id: e[1], txt: e[2], t: 10 }); if (chat.length > 6) chat.shift(); break;
    }
  }

  // ================================================================ the car fist fight: fight screen
  // While you are one of the two fighters, a side-on arena is drawn over everything. The game sends the fight's
  // state (S.Fight.pack rows in g.du); the last two snapshots are blended for smooth movement, and sounds and
  // effects come from the changes between them. Everyone else sees a cartoon brawl cloud in the street.
  const FA = S.Fight.A, FPH = S.Fight.PH, FMV = S.Fight.MV;
  const fight = { combo: [null, null], superT: 9, superBy: 0, impact: null, pred: null, pv: null, me: 0, oppK: 0, meta: null, hsDone: 0, vo: [0, 0], id: 0, parts: [], decals: [], texts: [], once: new Set(), trail: [100, 100], camX: S.Fight.AW / 2, excite: 0, shake: 0, flash: 0, sky: null, crowd: null, endT: 0, last: null, start: 0 };
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) {
    if (t <= 0) return a;
    const A = hexRgb(a), B = hexRgb(b);
    return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
  }
  // The game sends the fight's full state (S.Fight.save). Your page loads it, replays the keys you've pressed since
  // the game last heard from you, and keeps running the fight itself every tick: your own moves react instantly.
  // The other fighter is assumed to keep holding what they held; when their real keys arrive the fight is
  // re-run from the game's state (rollback), and a short visual ease hides any jump.
  function fightSnap(row, ack) {
    const now = performance.now();
    if (!row) {
      if (fight.pred) { fight.last = fightView(); fight.endT = now; }
      fight.pred = null; fight.pv = null; fight.id = 0;
      return;
    }
    const id = row[0];
    if (fight.id !== id) {
      // a new fight: build the scenery (seeded by the fight, so both fighters see the same street)
      Object.assign(fight, { combo: [null, null], superT: 9, id, pred: null, pv: null, hsDone: 0, vo: [0, 0], parts: [], decals: [], texts: [], once: new Set(), trail: [100, 100], camX: S.Fight.AW / 2, excite: 0, shake: 0, flash: 1, start: now, last: null });
      const R = S.rng(id * 977 + 13);
      fight.sky = [];
      for (let x = -900; x < S.Fight.AW + 900;) { const w = 70 + R() * 120; fight.sky.push({ x, w, h: 140 + Math.pow(R(), 1.3) * 420, c: Math.floor(R() * 4), s: Math.floor(R() * 1e6) }); x += w + R() * 10; }
      fight.crowd = [];
      const n = 9 + Math.floor(R() * 5);
      for (let i = 0; i < n; i++) fight.crowd.push({ x: -120 + (i + R() * 0.7) * ((S.Fight.AW + 240) / n), col: S.CAR_COLORS[Math.floor(R() * S.CAR_COLORS.length)], h: 0.85 + R() * 0.3, ph: R() * 6, skin: ['#d9a47a', '#a8754f', '#7a4f33', '#f0c9a0'][Math.floor(R() * 4)] });
      fight.lamps = [];
      for (let x = -600; x < S.Fight.AW + 600; x += 330) fight.lamps.push(x + R() * 60);
      Audio.play('fanfare');
    }
    fight.meta = { id, ids: [row[1], row[2]], wx: row[3], wy: row[4], carT: row[5], carCol: row[6] };
    fight.me = row[1] === myId ? 0 : 1;
    const base = S.Fight.load(row, 7);
    fight.oppK = base.f[1 - fight.me].pk;
    for (const i of pending) if (i.s > ack) S.Fight.step(base, fightKeys(i.k), DT);
    if (fight.pred) for (let i = 0; i < 2; i++) fight.vo[i] = clamp(fight.vo[i] + fight.pred.f[i].x - base.f[i].x, -80, 80);
    fight.pred = base;
    const v = fightView();
    fightEvents(fight.pv, v);
    fight.pv = v;
  }
  const fightKeys = (k) => (fight.me === 0 ? [k, fight.oppK] : [fight.oppK, k]);
  // one local tick of the fight, with the keys you're pressing right now
  function fightTick(k) {
    if (!fight.pred || fight.pred.done) return;
    S.Fight.step(fight.pred, fightKeys(k), DT);
    const v = fightView();
    fightEvents(fight.pv, v);
    fight.pv = v;
  }
  // the predicted fight in the form the fight screen draws
  function fightView() {
    const p = fight.pred;
    if (!p) return null;
    const d = Object.assign({}, fight.meta, { ph: p.ph, round: p.round, wins: [p.w0, p.w1], t: p.t, rt: Math.ceil(p.rt), win: p.win, rw: p.rw, fk: p.fk, flaw: p.flaw, res: p.res, hsRaw: p.hs, lh: [p.lh0, p.lh1, p.lh2, p.lh3], frz: p.frz, sf: p.sf });
    d.f = p.f.map((f, i) => ({ x: f.x + fight.vo[i], y: f.y, hp: Math.ceil(f.hp), act: f.act, at: f.at, fr: f.fr, face: f.face, combo: f.combo, cn: f.cn, px: f.pOn ? f.px : -999, pvx: f.pvx > 0 ? 1 : -1, pstr: f.pstr, meter: f.meter, str: f.str, back: f.back, hits: f.hits, rush: f.rush, rf: f.rf, stun: f.stun }));
    return d;
  }
  const fpart = (o) => { fight.parts.push(Object.assign({ t: 0, rot: 0, vr: 0 }, o)); if (fight.parts.length > 600) fight.parts.shift(); };
  function fBlood(x, y, n, dir, pow = 1) {
    for (let i = 0; i < n; i++) fpart({ k: 'blood', x, y, vx: dir * rnd(30, 280) * pow + rnd(-70, 70), vy: rnd(40, 380) * pow, life: rnd(0.7, 1.5), sz: rnd(2.5, 5.5), col: Math.random() < 0.3 ? '#7a0a0a' : '#c0141a' });
  }
  function fGibs(x, y, n, col) {
    const cs = ['#8a1010', '#b8322a', '#d9a47a', col, '#5a0c0c'];
    for (let i = 0; i < n; i++) fpart({ k: 'gib', x, y, vx: rnd(-320, 320), vy: rnd(150, 620), life: rnd(2.5, 4), sz: rnd(4, 10), col: cs[i % cs.length], vr: rnd(-12, 12) });
  }
  function fSpark(x, y, big, blocked) {
    fpart({ k: 'spark', x, y, life: big ? 0.24 : 0.15, sz: big ? 40 : 24, rot: rnd(0, 3), blk: blocked ? 1 : 0 });
    for (let i = 0; i < (big ? 8 : 4); i++) fpart({ k: 'chip', x, y, vx: rnd(-260, 260), vy: rnd(-80, 260), life: rnd(0.15, 0.3), sz: rnd(2, 3) });
  }
  function fDust(x, n = 8) { for (let i = 0; i < n; i++) fpart({ k: 'dust', x: x + rnd(-24, 24), y: 4, vx: rnd(-90, 90), vy: rnd(10, 60), life: rnd(0.4, 0.8), sz: rnd(8, 16) }); }
  function fFire(x, y, n) { for (let i = 0; i < n; i++) fpart({ k: 'fire', x: x + rnd(-16, 16), y: y + rnd(-10, 10), vx: rnd(-30, 30), vy: rnd(60, 170), life: rnd(0.3, 0.75), sz: rnd(8, 18) }); }
  function fText(txt, side, col, big) { fight.texts.push({ txt, side, col, big, t: 0 }); if (fight.texts.length > 6) fight.texts.shift(); }
  // where in the arena a sound comes from, mapped into the street around you so it pans
  const fsnd = (name, x, vol = 1) => Audio.play(name, cam.x + ((x === undefined ? S.Fight.AW / 2 : x) - fight.camX) * 1.1, cam.y, vol);
  function fightEvents(p, d) {
    const key = 'ph' + d.round + ':' + d.ph;
    if (!fight.once.has(key)) {
      fight.once.add(key);
      if (d.ph === FPH.INTRO) {
        const fin = d.wins[0] === F_W1 && d.wins[1] === F_W1;
        Audio.announce(fin ? 'round3' : d.round === 1 ? 'round1' : d.round === 2 ? 'round2' : 'roundx', fin ? 'Final round' : 'Round ' + d.round);
      } else if (d.ph === FPH.FIGHT) Audio.announce('fight', 'Fight!');
      else if (d.ph === FPH.KO) {
        if (d.rw >= 0) { fsnd('boom', d.f[1 - d.rw].x, 0.35); if (d.flaw) setTimeout(() => Audio.announce('flawless', 'Flawless victory'), 900); }
      } else if (d.ph === FPH.FINISH) { setTimeout(() => Audio.announce('finish', 'Finish him!'), 450); }
      else if (d.ph === FPH.OVER && d.res !== 2) setTimeout(() => Audio.announce('victory', 'Victory'), 500);
    }
    // a hit (or a block): each one only once, even if the fight gets re-run
    if (d.hsRaw > fight.hsDone && d.lh[0] >= 0) {
      fight.hsDone = d.hsRaw;
      if (d.lh[0] === 2) { const mx = (d.f[0].x + d.f[1].x) / 2; fSpark(mx, 104, true); fsnd('clunk', mx, 1); return; } // two hubcaps collide
      const vi = d.lh[0], v = d.f[vi], at = d.f[1 - vi], dir = Math.sign(v.x - at.x) || 1;
      const act = d.lh[3], mv0 = FMV[act], hi = act === FA.HUBCAP ? 104 : act === FA.THROW ? 50 : mv0 && mv0.hy ? mv0.hy : 110;
      const cx = v.x - dir * 16, cy = (act === FA.THROW ? 0 : at.y) * 0.3 + v.y * 0.7 + hi;
      if (d.lh[2]) { fSpark(cx, cy, false, true); fsnd('clunk', cx, 0.6); }
      else {
        fSpark(cx, cy, d.lh[1] >= 10);
        if (d.lh[1] >= 10) fight.impact = { x: cx, y: cy, t: 0 };
        fBlood(cx, cy, 4 + d.lh[1], dir, 0.6 + d.lh[1] / 20);
        fsnd('punch', cx, 0.6 + d.lh[1] / 18);
        fight.shake = Math.min(18, fight.shake + d.lh[1] * 0.9);
        fight.excite = 1;
        if (Math.random() < 0.45) Audio.voice(voiceOf(d.ids[vi]), 'hurt', cam.x, cam.y, 0.8);
        if (act === FA.RISING || act === FA.HK || act === FA.SUPER || act === FA.THROW) fsnd('crash', cx, 0.25);
      }
    }
    if (!p) return;
    for (let i = 0; i < 2; i++) {
      const f = d.f[i], o = p.f[i];
      if (f.combo >= 2 && f.combo > o.combo) fight.combo[i] = { n: f.combo, t: 0 };
      if (d.sf === i + 1 && !(p.sf === i + 1)) { fight.superT = 0; fight.superBy = i; fight.flash = 0.5; fsnd('whoosh', f.x, 1.4); fsnd('boom', f.x, 0.3); Audio.announce('excellent', 'Super'); }
      if (f.cn && (f.cn !== o.cn || f.combo !== o.combo)) {
        fText(S.Fight.COMBOS[f.cn] + '!', i, '#ff5a2a', true);
        Audio.announce(f.cn === 1 ? 'combo' : f.cn === 2 ? 'excellent' : 'brutal', S.Fight.COMBOS[f.cn]);
      }
      if (f.act !== o.act) {
        const mv = FMV[f.act];
        if (mv && mv.name && f.act !== FA.SUPER) { fight.texts.push({ txt: mv.name + '!', fi: i, t: 0, col: '#fff' }); fsnd('whoosh', f.x, 0.9); }
        else if (mv) fsnd('whoosh', f.x, 0.4);
        if (f.act === FA.JUMP && o.act === FA.PREJUMP) fsnd('jump', f.x, 0.6);
        if (f.act === FA.DASH || f.act === FA.BDASH) { fDust(f.x, 6); fsnd('whoosh', f.x, 0.5); }
        if (f.act === FA.DOWN || (f.act === FA.LAND && o.act !== FA.LAND)) { fDust(f.x, f.act === FA.DOWN ? 12 : 5); fsnd('land', f.x, f.act === FA.DOWN ? 1 : 0.5); }
      }
    }
  }
  const F_W1 = S.Fight.WINS - 1;
  // ---------------- fighter poses
  // Angles are from straight down; positive swings forward (towards the opponent). Elbows/knees bend relative to that.
  function fPose(f, tt, char) {
    const P = { lean: 0.06, rot: 0, head: 0, aF: [0.9, 1.9], aB: [0.55, 2.15], lF: [0.32, -0.32], lB: [-0.28, -0.12], lift: 0, ground: true, spin: 0 };
    const at = f.at, mv = FMV[f.act], c01 = (x) => clamp(x, 0, 1);
    let w = 0;
    if (mv) w = at < mv.s ? E.outQuad(at / mv.s) : at < mv.s + mv.a ? 1 : mv.r > 0 ? 1 - E.inOutCubic(c01((at - mv.s - mv.a) / mv.r)) : 1;
    const bob = Math.sin(tt * 6);
    const crouch = (P2) => { P2.lF = [1.3, -2.15]; P2.lB = [0.35, -2.2]; P2.lean = 0.28; };
    const guard = (P2) => { P2.aF = [1.25, 2.2 + bob * 0.05]; P2.aB = [0.95, 2.35]; };
    switch (f.act) {
      case FA.IDLE: guard(P); P.lF = [0.36 + bob * 0.04, -0.38 - bob * 0.09]; P.lB = [-0.3 + bob * 0.03, -0.16 - bob * 0.09]; P.lift = -bob * 1.5; P.lean = 0.1; break;
      case FA.WALK: { const c = Math.sin(tt * 11); guard(P); P.lF = [0.12 + c * 0.42, -0.18 - Math.max(0, -c) * 0.6]; P.lB = [0.12 - c * 0.42, -0.18 - Math.max(0, c) * 0.6]; P.lean = 0.12; break; }
      case FA.DASH: { const k = c01(at / 0.2); P.lean = 0.45; guard(P); P.lF = [1.1, -1.2 * k]; P.lB = [-0.8, -0.6]; break; }
      case FA.BDASH: { P.lean = -0.25; guard(P); P.lF = [0.7, -0.9]; P.lB = [-0.2, -1.4]; P.lift = Math.sin(c01(at / 0.3) * Math.PI) * 10; break; }
      case FA.CROUCH: crouch(P); guard(P); break;
      case FA.PREJUMP: case FA.LAND: crouch(P); P.lean = 0.15; guard(P); break;
      case FA.BLOCK: P.aF = [1.55, 2.45]; P.aB = [1.3, 2.6]; P.lean = -0.12; P.head = -0.15; P.lF = [0.2, -0.3]; P.lB = [-0.4, -0.2]; break;
      case FA.CBLOCK: crouch(P); P.aF = [1.6, 2.4]; P.aB = [1.35, 2.55]; P.lean = 0.12; break;
      case FA.JUMP: P.ground = false; P.lF = [1.5, -2.3]; P.lB = [0.85, -2.25]; P.aF = [1.6, 1.3]; P.aB = [0.8, 1.7]; break;
      // standing normals
      case FA.LP: guard(P); P.aF = [lerp(1.25, 1.6, w), lerp(2.2, 0.05, w)]; P.lean = 0.1 + 0.12 * w; break;
      case FA.HP: P.aF = [lerp(1.0, 1.62, w), lerp(2.2, 0, w)]; P.aB = [lerp(0.95, -0.4, w), lerp(2.35, 2.4, w)]; P.lean = 0.05 + 0.3 * w; P.lF = [lerp(0.36, 0.7, w), lerp(-0.38, -0.5, w)]; P.lB = [lerp(-0.3, -0.6, w), -0.05]; break;
      case FA.LK: guard(P); P.lF = [lerp(0.32, 1.3, w), lerp(-0.32, 0, w)]; P.lB = [-0.1, -0.08]; P.lean = -0.18 * w; break;
      case FA.HK: P.lF = [lerp(0.32, 2.0, w), lerp(-0.4, 0.05, w)]; P.lB = [-0.15, -0.05]; P.lean = -0.5 * w; P.aF = [lerp(1.2, 0.3, w), 1.5]; P.aB = [lerp(0.9, -0.7, w), 1.2]; P.spin = at < mv.s ? 0.5 * at / mv.s : 0; break;
      // crouching normals
      case FA.CLP: crouch(P); guard(P); P.aF = [lerp(1.25, 1.55, w), lerp(2.2, 0.1, w)]; break;
      case FA.CHP: P.lF = [lerp(1.3, 0.35, w), lerp(-2.15, -0.25, w)]; P.lB = [lerp(0.35, -0.3, w), lerp(-2.2, -0.1, w)]; P.lean = lerp(0.3, -0.12, w); P.aF = [lerp(1.0, 2.95, w), lerp(2.3, 0.25, w)]; P.aB = [0.3, 1.6]; P.lift = w * 6; break;
      case FA.CLK: crouch(P); guard(P); P.lF = [lerp(1.3, 1.5, w), lerp(-2.15, 0, w)]; P.lean = 0.3 - 0.1 * w; break;
      case FA.CHK: P.lean = 0.55; P.lF = [lerp(0.7, 1.58, w), lerp(-1.6, 0, w)]; P.lB = [0.95, -2.45]; P.aF = [0.6, 0.6]; P.aB = [-0.1, 0.5]; break;
      // jumping normals
      case FA.JLP: P.ground = false; P.lF = [1.5, -2.3]; P.lB = [0.85, -2.25]; P.aF = [lerp(1.6, 1.25, w), lerp(1.3, 0.05, w)]; P.aB = [0.8, 1.7]; break;
      case FA.JHP: P.ground = false; P.lF = [1.3, -2.0]; P.lB = [0.6, -2.0]; P.aF = [lerp(2.8, 1.0, w), lerp(0.6, 0, w)]; P.aB = [lerp(2.5, 0.6, w), 0.8]; P.lean = 0.2 * w; break;
      case FA.JLK: P.ground = false; P.lF = [lerp(1.4, 1.2, w), lerp(-2.2, 0, w)]; P.lB = [0.6, -2.3]; P.lean = -0.28 * w; P.aF = [0.4, 1.2]; P.aB = [-0.6, 1.0]; break;
      case FA.JHK: P.ground = false; P.lF = [lerp(1.4, 1.62, w), lerp(-2.2, 0, w)]; P.lB = [lerp(0.6, 0.1, w), lerp(-2.2, -1.4, w)]; P.lean = -0.4 * w; P.aF = [1.6, 0.6]; P.aB = [-0.8, 0.8]; break;
      // specials
      case FA.HUBCAP: if (at < mv.s) P.aF = [lerp(0.9, -1.5, E.outQuad(at / mv.s)), 0.9]; else P.aF = [lerp(-1.5, 1.75, c01((at - mv.s) / 0.08)), 0.2]; P.lean = at < mv.s ? -0.1 : 0.3; P.lF = [0.6, -0.3]; P.lB = [-0.5, -0.1]; break;
      case FA.RISING: { const k = at < mv.s ? at / mv.s : 1; P.ground = !(f.y > 2); P.aF = [lerp(1.0, 3.05, k), lerp(2.3, 0.05, k)]; P.aB = [0.2, 1.4]; P.lF = [lerp(1.3, 1.1, k), lerp(-2.1, -1.8, k)]; P.lB = [lerp(0.35, -0.2, k), lerp(-2.2, -0.2, k)]; P.lean = lerp(0.3, -0.18, k); P.spin = f.str && at > mv.s && at < mv.s + 0.15 ? ((at - mv.s) / 0.15) : 0; break; }
      case FA.SPIN: { const on = at >= mv.s && f.y > 1; P.ground = !on; P.lF = on ? [1.6, 0] : [0.9, -1.4]; P.lB = on ? [-0.2, -0.6] : [0.2, -1.6]; P.aF = [1.3, 0.4]; P.aB = [-1.3, 0.4]; P.lean = -0.15; if (on) P.spin = ((at - mv.s) * 7) % 1; break; }
      case FA.SUPER: {
        if (f.rush) { const k = (f.rf % 6) / 6, side = Math.floor(f.rf / 6) % 2; const a1 = [lerp(1.6, 1.2, k), lerp(0.05, 2.0, k)], a2 = [1.2, 2.2]; P.aF = side ? a1 : a2; P.aB = side ? a2 : a1; P.lean = 0.25; P.lF = [0.7, -0.5]; P.lB = [-0.6, -0.1]; }
        else if (at < mv.s) { crouch(P); P.aF = [-0.4, 1.2]; P.aB = [-0.8, 1.0]; }
        else { P.lean = 0.5; P.aF = [1.6, 0.1]; P.aB = [-0.9, 0.9]; P.lF = [1.2, -1.0]; P.lB = [-0.9, -0.4]; }
        break;
      }
      case FA.THROW: {
        // grab, haul them up (arms go overhead), then the heave: forward it's a shoulder toss, back it's over the top
        const g = c01(at / Math.max(0.01, mv.s)), k = c01((at - mv.s) / (20 / 60)), r = c01((at - mv.s - 20 / 60) / 0.2);
        const up = Math.sin(Math.min(1, k * 1.15) * Math.PI * 0.85);
        P.aF = [lerp(1.4, f.back ? 3.1 : 2.4, Math.max(g * 0.4, up)) - r * 0.9, lerp(0.6, 0.15, k)]; P.aB = [lerp(1.3, f.back ? 3.0 : 2.2, Math.max(g * 0.3, up)) - r * 0.8, 0.6];
        P.lean = f.back ? lerp(0.2, -0.55, k) + r * 0.4 : lerp(0.15, -0.2, up) + k * 0.45 - r * 0.2;
        P.lF = [lerp(0.5, 0.75, k), -0.4]; P.lB = [lerp(-0.4, -0.7, k), -0.1]; P.lift = -6 * up; break;
      }
      case FA.THROWN: {
        // jk: 1 thrown forward, 2 thrown over the head; they tumble along the swing, flailing
        const k = c01(at / (20 / 60)), fl = Math.sin(tt * 30) * 0.25;
        P.ground = false; P.rot = f.jk === 2 ? -k * 3.0 : -0.4 - k * 1.5;
        P.aF = [2.3 + fl, 0.4]; P.aB = [1.4 - fl, 0.8]; P.lF = [0.9 + fl, -0.6]; P.lB = [0.3 - fl, -0.3]; P.head = -0.35; break;
      }
      case FA.HURT: { const k = 1 - c01(at / 0.3); P.lean = -0.4 * k - 0.04; P.head = -0.5 * k; P.aF = [0.5, 0.6]; P.aB = [-0.4, 0.5]; P.lF = [0.4, -0.3]; P.lB = [-0.4, -0.1]; break; }
      case FA.FALL: P.ground = false; P.rot = -lerp(0.35, 1.5, c01(at / 0.5)); P.aF = [2.2, 0.4]; P.aB = [1.6, 0.7]; P.lF = [0.9, -0.4]; P.lB = [0.25, -0.2]; P.head = -0.3; break;
      case FA.DOWN: case FA.KO: P.ground = false; P.rot = -1.52; P.aF = [2.6, 0.2]; P.aB = [2.95, 0.1]; P.lF = [0.12, -0.12]; P.lB = [-0.05, 0]; break;
      case FA.GETUP: { const k = E.outCubic(c01(at / 0.23)); P.ground = false; P.rot = -1.52 * (1 - k); P.lF = [lerp(1.3, 0.32, k), lerp(-2.1, -0.32, k)]; break; }
      case FA.DIZZY: P.lean = Math.sin(tt * 3.1) * 0.22; P.head = Math.sin(tt * 3.1 + 1) * 0.32; P.aF = [0.2 + Math.sin(tt * 3) * 0.15, 0.35]; P.aB = [0.1, 0.25]; P.lF = [0.16, -0.16]; P.lB = [-0.1, -0.08]; break;
      case FA.WIN: P.aF = [3.0, 0.15 + Math.max(0, Math.sin(tt * 8)) * 0.5]; P.aB = [0.35, 1.9]; P.lean = -0.06; P.lift = Math.max(0, Math.sin(tt * 8)) * 4; break;
    }
    if (char) { P.aF[0] += Math.sin(tt * 19) * 0.8 * (1 - char); P.aB[0] += Math.cos(tt * 17) * 0.8 * (1 - char); }
    return P;
  }
  const FT = { T: 50, th: 37, sh: 36, ua: 27, fa: 26 };
  function limbPts(x0, y0, a1, l1, a2, l2) {
    const x1 = x0 + Math.sin(a1) * l1, y1 = y0 - Math.cos(a1) * l1;
    return [x0, y0, x1, y1, x1 + Math.sin(a1 + a2) * l2, y1 - Math.cos(a1 + a2) * l2];
  }
  // draws one fighter with feet at (0,0), y up, facing +x
  function drawFighterBody(g, P, col, opt = {}) {
    const ch = opt.char || 0, dark = '#140d0b';
    const skin = mix(opt.skin || '#d9a47a', dark, ch), shirt = mix(col, dark, ch), shirtB = mix(shade(col, -0.32), dark, ch);
    const pants = mix('#2a2d35', dark, ch), pantsB = mix('#1b1d23', dark, ch), hair = mix(opt.hair || '#2b1d14', dark, ch * 0.6);
    // legs first, so the hip can sit at whatever height puts the feet on the ground
    const lB = limbPts(-3, 0, P.lB[0], FT.th, P.lB[1], FT.sh), lF = limbPts(3, 0, P.lF[0], FT.th, P.lF[1], FT.sh);
    const lie = Math.abs(Math.sin(P.rot || 0));
    let hipY = P.ground ? -Math.min(lB[5], lF[5]) + 5 : lerp(70, 13, lie);
    hipY += P.lift || 0;
    g.save();
    g.translate(-lie * 24, hipY);
    if (P.rot) g.rotate(-P.rot); // negative rot: falling over backwards
    if (P.spin > 0.15 && P.spin < 0.85) g.scale(-1, 1); // mid-spin: seen from behind
    const sh = [Math.sin(P.lean) * FT.T, Math.cos(P.lean) * FT.T];
    const aB = limbPts(sh[0] - 3, sh[1] - 4, P.aB[0], FT.ua, P.aB[1], FT.fa), aF = limbPts(sh[0] + 3, sh[1] - 4, P.aF[0], FT.ua, P.aF[1], FT.fa);
    const line = (pts, w, c) => {
      g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.strokeStyle = '#000'; g.lineWidth = w + 5; g.stroke(); g.strokeStyle = c; g.lineWidth = w; g.stroke();
    };
    const foot = (pts, c) => { const x = pts[4], y = pts[5]; g.fillStyle = '#000'; rr(g, x - 6, y - 5, 19, 9, 3); g.fill(); g.fillStyle = c; rr(g, x - 4.5, y - 3.5, 16, 6, 2.5); g.fill(); };
    const fist = (pts, c) => { g.fillStyle = '#000'; g.beginPath(); g.arc(pts[4], pts[5], 7.5, 0, 7); g.fill(); g.fillStyle = c; g.beginPath(); g.arc(pts[4], pts[5], 5.5, 0, 7); g.fill(); };
    g.lineCap = 'round'; g.lineJoin = 'round';
    line(aB, 9, shade(skin.startsWith('#') ? skin : '#c08a60', -0.15)); fist(aB, skin);
    line([aB[0], aB[1], aB[2], aB[3]], 11, shirtB);
    line(lB, 13, pantsB); foot(lB, '#0d0d0d');
    // torso + hips
    line([0, 0, sh[0], sh[1]], 30, shirt);
    g.fillStyle = mix('#1a1a1a', dark, ch); g.save(); g.translate(0, 2); g.rotate(P.lean * 0.5); g.fillRect(-15, -3, 30, 6); g.restore();
    line([-3, -2, 3, -2], 22, pants);
    // head
    const ha = P.lean + P.head, hx = sh[0] + Math.sin(ha) * 19, hy = sh[1] + Math.cos(ha) * 19;
    g.fillStyle = '#000'; g.beginPath(); g.arc(hx, hy, 15.5, 0, 7); g.fill();
    g.fillStyle = skin; g.beginPath(); g.arc(hx, hy, 13, 0, 7); g.fill();
    g.save(); g.translate(hx, hy); g.rotate(-ha); g.fillStyle = hair; g.beginPath(); g.arc(0, 0, 13.5, Math.PI * 0.12, Math.PI * 1.3); g.lineTo(-4, 4); g.closePath(); g.fill(); g.restore();
    if (opt.eyes === 'x') { g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.moveTo(hx + 3, hy - 1); g.lineTo(hx + 9, hy + 5); g.moveTo(hx + 9, hy - 1); g.lineTo(hx + 3, hy + 5); g.stroke(); }
    else if (!ch || ch < 0.7) { g.fillStyle = '#111'; g.fillRect(hx + 5, hy + 1, 3.2, 3.2); g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(hx + 4, hy - 6, 6, 2); }
    line(lF, 13, pants); foot(lF, '#0d0d0d');
    line([aF[0], aF[1], aF[2], aF[3]], 11, shirt);
    line([aF[2], aF[3], aF[4], aF[5]], 9, skin); fist(aF, skin);
    g.restore();
    return { hipY, head: [hx, hy + hipY], hand: [aF[4], aF[5] + hipY] };
  }

  // a car seen from the side, wheels on y = 0, front towards +x; L = length in fight units
  function drawSideCar(g, t, col, L, opt = {}) {
    const C = S.CARS[t] || S.CARS[0], body = S.CAR_COLORS[col] || '#c4302b';
    const tall = C.kind === 'bus' ? 2.2 : C.kind === 'van' ? 1.7 : 1, Hb = L * 0.16 * Math.min(tall, 1.25), wr = L * 0.075;
    const roofH = C.kind === 'bus' || C.kind === 'van' ? L * 0.2 * tall : C.kind === 'sports' ? L * 0.1 : L * 0.135;
    g.save();
    g.lineJoin = 'round';
    // shadow
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(0, -2, L * 0.55, 9, 0, 0, 7); g.fill();
    const y0 = wr * 0.9;
    g.strokeStyle = '#000'; g.lineWidth = 4;
    // cabin
    g.fillStyle = shade(body, -0.12);
    g.beginPath();
    if (C.kind === 'bus' || C.kind === 'van') {
      const x0 = C.kind === 'van' ? -L * 0.48 : -L * 0.48, x1 = C.kind === 'van' ? L * 0.18 : L * 0.46;
      g.moveTo(x0, y0 + Hb); g.lineTo(x0, y0 + Hb + roofH); g.lineTo(x1, y0 + Hb + roofH); g.lineTo(x1 + (C.kind === 'van' ? 0 : 4), y0 + Hb);
      if (C.kind === 'van') { g.closePath(); g.fill(); g.stroke(); g.beginPath(); g.moveTo(L * 0.2, y0 + Hb); g.lineTo(L * 0.22, y0 + Hb + roofH * 0.62); g.lineTo(L * 0.34, y0 + Hb + roofH * 0.6); g.lineTo(L * 0.42, y0 + Hb); }
    } else if (C.kind === 'pickup') {
      g.moveTo(-L * 0.02, y0 + Hb); g.lineTo(L * 0.02, y0 + Hb + roofH); g.lineTo(L * 0.2, y0 + Hb + roofH); g.lineTo(L * 0.3, y0 + Hb);
    } else {
      g.moveTo(-L * 0.3, y0 + Hb); g.lineTo(-L * 0.2, y0 + Hb + roofH); g.lineTo(L * 0.12, y0 + Hb + roofH); g.lineTo(L * 0.27, y0 + Hb);
    }
    g.closePath(); g.fill(); g.stroke();
    // windows
    g.fillStyle = opt.night ? '#1d2a3b' : '#9cc3e0';
    if (C.kind === 'bus') { for (let x = -L * 0.44; x < L * 0.4; x += L * 0.11) { g.fillRect(x, y0 + Hb + roofH * 0.3, L * 0.08, roofH * 0.55); } }
    else if (C.kind === 'van') { g.beginPath(); g.moveTo(L * 0.24, y0 + Hb + 4); g.lineTo(L * 0.25, y0 + Hb + roofH * 0.55); g.lineTo(L * 0.33, y0 + Hb + roofH * 0.53); g.lineTo(L * 0.39, y0 + Hb + 4); g.fill(); }
    else if (C.kind === 'pickup') { g.beginPath(); g.moveTo(L * 0.04, y0 + Hb + 4); g.lineTo(L * 0.06, y0 + Hb + roofH - 4); g.lineTo(L * 0.18, y0 + Hb + roofH - 4); g.lineTo(L * 0.26, y0 + Hb + 4); g.fill(); }
    else {
      g.beginPath(); g.moveTo(-L * 0.25, y0 + Hb + 4); g.lineTo(-L * 0.18, y0 + Hb + roofH - 4); g.lineTo(-L * 0.05, y0 + Hb + roofH - 4); g.lineTo(-L * 0.05, y0 + Hb + 4); g.fill();
      g.beginPath(); g.moveTo(-L * 0.02, y0 + Hb + 4); g.lineTo(-L * 0.02, y0 + Hb + roofH - 4); g.lineTo(L * 0.1, y0 + Hb + roofH - 4); g.lineTo(L * 0.22, y0 + Hb + 4); g.fill();
    }
    // body
    g.fillStyle = body; rr(g, -L / 2, y0, L, Hb, 7); g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(-L / 2 + 6, y0 + Hb - 7, L - 12, 3);
    g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(-L / 2 + 4, y0 + 3, L - 8, 4);
    // lights, door line, extras
    g.fillStyle = '#ffe9a0'; g.fillRect(L / 2 - 7, y0 + Hb * 0.55, 6, Hb * 0.25);
    g.fillStyle = '#d42020'; g.fillRect(-L / 2 + 1, y0 + Hb * 0.55, 5, Hb * 0.25);
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-L * 0.04, y0 + 4); g.lineTo(-L * 0.04, y0 + Hb - 2); g.stroke();
    if (C.kind === 'taxi') { g.fillStyle = '#000'; g.fillRect(-L * 0.08, y0 + Hb + roofH, L * 0.14, 9); g.fillStyle = '#ffd21f'; g.fillRect(-L * 0.07, y0 + Hb + roofH + 1, L * 0.12, 7); }
    if (C.kind === 'police') { const ph = Math.floor(performance.now() / 140) % 2; g.fillStyle = ph ? '#ff2a2a' : '#5a1010'; g.fillRect(-L * 0.1, y0 + Hb + roofH, L * 0.08, 7); g.fillStyle = ph ? '#14246b' : '#3d7bff'; g.fillRect(-L * 0.02, y0 + Hb + roofH, L * 0.08, 7); }
    if (C.kind === 'pickup') { g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeRect(-L * 0.48, y0 + Hb - 1, L * 0.44, 8); }
    // wheels (with hubcaps, naturally)
    const wheels = C.kind === 'bus' ? [-0.34, 0.3] : [-0.31, 0.3];
    for (const wx of wheels) {
      if (opt.noCap === wx) continue;
      g.fillStyle = '#000'; g.beginPath(); g.arc(L * wx, wr, wr + 2, 0, 7); g.fill();
      g.fillStyle = '#1b1b1b'; g.beginPath(); g.arc(L * wx, wr, wr, 0, 7); g.fill();
      g.fillStyle = '#b9bec4'; g.beginPath(); g.arc(L * wx, wr, wr * 0.55, 0, 7); g.fill();
      g.fillStyle = '#7d838a'; g.beginPath(); g.arc(L * wx, wr, wr * 0.2, 0, 7); g.fill();
    }
    g.restore();
  }
  function drawHubcap(g, x, y, s, spin) {
    g.save(); g.translate(x, y); g.scale(s * Math.max(0.25, Math.abs(Math.cos(spin))), s);
    g.fillStyle = '#000'; g.beginPath(); g.arc(0, 0, 13, 0, 7); g.fill();
    g.fillStyle = '#c9ced4'; g.beginPath(); g.arc(0, 0, 11, 0, 7); g.fill();
    g.fillStyle = '#80868d'; g.beginPath(); g.arc(0, 0, 4, 0, 7); g.fill();
    g.strokeStyle = '#80868d'; g.lineWidth = 1.5; g.beginPath(); for (let i = 0; i < 5; i++) { const a = spin * 3 + (i * Math.PI * 2) / 5; g.moveTo(Math.cos(a) * 5, Math.sin(a) * 5); g.lineTo(Math.cos(a) * 10, Math.sin(a) * 10); } g.stroke();
    g.restore();
  }
  function star5(g, x, y, r, rot) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = rot + (i * Math.PI) / 5, rr2 = i % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); } g.closePath(); }

  // ---------------- the whole fight screen
  function drawFight(dt) {
    let d = fightView(), alpha = 1;
    const nowMs = performance.now();
    if (!d) {
      if (!fight.last || nowMs - fight.endT > 450) return;
      d = fight.last; alpha = 1 - (nowMs - fight.endT) / 450;
    }
    const me0 = d.ids[0] === myId ? 0 : d.ids[1] === myId ? 1 : -1;
    const tt = nowMs / 1000, AW = S.Fight.AW;
    const g = ctx;
    const U = Math.min(W, H * 1.7) / 1100;
    const s = Math.min(W / 600, H / 370);
    const gy = H * 0.8;
    // camera follows the fighters (and the fatality)
    const viewHalf = W / 2 / s;
    let mid = (d.f[0].x + d.f[1].x) / 2;
    fight.camX = damp(fight.camX, AW + 80 > viewHalf * 2 ? clamp(mid, viewHalf - 40, AW + 40 - viewHalf) : AW / 2, 4, dt);
    fight.vo[0] *= Math.exp(-dt * 14); fight.vo[1] *= Math.exp(-dt * 14);
    fight.shake *= Math.exp(-dt * 9); fight.flash = Math.max(0, fight.flash - dt * 2.5); fight.excite = Math.max(0, fight.excite - dt * 0.8);
    const shx = (Math.random() - 0.5) * fight.shake * s * 0.6, shy = (Math.random() - 0.5) * fight.shake * s * 0.6;
    const LX = (x, p = 1) => W / 2 + (x - fight.camX) * s * p + shx;
    const night = sun.night || 0;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    alpha *= clamp((nowMs - fight.start) / 250, 0, 1);
    g.globalAlpha = alpha;
    // sky
    const sk = g.createLinearGradient(0, 0, 0, gy);
    // a big orange evening sky, sun going down behind the city (at night: dark blue)
    sk.addColorStop(0, mix('#3b2f7a', '#05081a', night)); sk.addColorStop(0.45, mix('#e2683a', '#1a2040', night)); sk.addColorStop(0.85, mix('#ffc46a', '#26304f', night));
    g.fillStyle = sk; g.fillRect(0, 0, W, H);
    if (night < 0.6) {
      const sx0 = LX(AW * 0.62, 0.12), sy0 = gy - 190 * s, sr = 70 * s;
      const sg2 = g.createRadialGradient(sx0, sy0, sr * 0.6, sx0, sy0, sr * 3); sg2.addColorStop(0, `rgba(255,220,140,${0.5 * (1 - night)})`); sg2.addColorStop(1, 'rgba(255,160,80,0)');
      g.fillStyle = sg2; g.fillRect(0, 0, W, H);
      g.fillStyle = `rgba(255,236,170,${1 - night})`; g.beginPath(); g.arc(sx0, sy0, sr, 0, 7); g.fill();
    }
    if (night > 0.4) { g.fillStyle = `rgba(255,255,240,${(night - 0.4) * 0.9})`; g.beginPath(); g.arc(W * 0.82, H * 0.14, 22 * U, 0, 7); g.fill(); }
    // skyline
    const hz = gy - 112 * s;
    for (const b of fight.sky) {
      const x = LX(b.x, 0.35), w = b.w * s * 0.35, h = b.h * s * 0.42;
      if (x + w < 0 || x > W) continue;
      g.fillStyle = mix(['#4a3550', '#3d2c46', '#5a3c52', '#33263d'][b.c], '#0b0f1e', night * 0.85);
      g.fillRect(x, hz - h + shy, w, h);
      const R = S.rng(b.s);
      for (let wy = hz - h + 10 * s * 0.35; wy < hz - 8; wy += 16 * s * 0.42) for (let wx = x + 6 * s * 0.35; wx < x + w - 8; wx += 14 * s * 0.35) {
        const lit = R() < (night > 0.3 ? 0.35 : 0.08);
        g.fillStyle = lit ? (night > 0.3 ? 'rgba(255,214,120,.85)' : 'rgba(200,220,240,.35)') : 'rgba(0,0,0,.18)';
        g.fillRect(wx, wy + shy, 6 * s * 0.35, 8 * s * 0.42);
      }
    }
    // pavement and kerb
    const kerbY = gy - 44 * s;
    g.fillStyle = mix('#9b9a92', '#3b3d47', night * 0.8); g.fillRect(0, hz + shy, W, kerbY - hz);
    g.fillStyle = mix('#888780', '#33353e', night * 0.8);
    for (let x = ((LX(0, 0.85) % (40 * s)) + 40 * s) % (40 * s) - 40 * s; x < W; x += 40 * s) g.fillRect(x, hz + shy, 2, kerbY - hz);
    // street lamps
    for (const lx of fight.lamps) {
      const x = LX(lx, 0.7); if (x < -60 || x > W + 60) continue;
      g.fillStyle = '#1d1f24'; g.fillRect(x - 3 * s * 0.7, hz - 230 * s * 0.7 + shy, 6 * s * 0.7, 230 * s * 0.7 + (kerbY - hz) * 0.3);
      g.fillRect(x - 3 * s * 0.7, hz - 230 * s * 0.7 + shy, 34 * s * 0.7, 5 * s * 0.7);
      g.fillStyle = night > 0.3 ? '#fff1b8' : '#d8d8cf'; g.fillRect(x + 22 * s * 0.7, hz - 226 * s * 0.7 + shy, 14 * s * 0.7, 6 * s * 0.7);
      if (night > 0.3) { const gr = g.createRadialGradient(x + 29 * s * 0.7, hz - 220 * s * 0.7, 0, x + 29 * s * 0.7, hz - 220 * s * 0.7, 160 * s * 0.7); gr.addColorStop(0, `rgba(255,220,140,${0.35 * night})`); gr.addColorStop(1, 'rgba(255,220,140,0)'); g.fillStyle = gr; g.fillRect(x - 160 * s, hz - 400 * s * 0.7, 340 * s, 420 * s); }
    }
    // the crowd
    for (const c of fight.crowd) {
      const x = LX(c.x, 0.8); if (x < -40 || x > W + 40) continue;
      const hop = fight.excite > 0.05 ? Math.abs(Math.sin(tt * 9 + c.ph)) * 8 * fight.excite : Math.abs(Math.sin(tt * 2 + c.ph)) * 1.5;
      g.save(); g.translate(x, kerbY - 30 * s + shy - hop * s * 0.5); g.scale(s * 0.46 * c.h, -s * 0.46 * c.h);
      const P = { lean: 0, rot: 0, head: 0, aF: fight.excite > 0.1 ? [2.9, 0.3] : [0.2, 0.4], aB: fight.excite > 0.1 ? [2.6, 0.5] : [0.1, 0.3], lF: [0.1, -0.05], lB: [-0.1, -0.05], lift: 0, ground: true, spin: 0 };
      g.globalAlpha = alpha * 0.92;
      drawFighterBody(g, P, mix(c.col, '#202533', 0.35 + night * 0.4), { skin: c.skin });
      g.restore();
    }
    g.globalAlpha = alpha;
    // the car they're fighting over, parked behind them (unless it's about to fall on someone)
    const carL = (S.CARS[d.carT] || S.CARS[0]).len * 6.5;
    const crush = d.ph >= FPH.FATAL && d.fk === 1;
    if (!crush) { g.save(); g.translate(LX(AW / 2, 0.9), kerbY - 6 * s + shy); g.scale(s * 0.86, -s * 0.86); drawSideCar(g, d.carT, d.carCol, carL, { night: night > 0.5 }); g.restore(); }
    g.globalAlpha = alpha;
    // kerb and road
    g.fillStyle = mix('#c9c7bd', '#5a5b63', night * 0.7); g.fillRect(0, kerbY + shy, W, 7 * s);
    g.fillStyle = mix('#3b3c40', '#191a20', night * 0.6); g.fillRect(0, kerbY + 7 * s + shy, W, H - kerbY);
    g.fillStyle = 'rgba(0,0,0,.12)'; for (let i = 0; i < 40; i++) { const R = S.rng(i * 7 + 1); g.fillRect(LX(R() * AW * 1.6 - AW * 0.3), kerbY + 12 * s + R() * (H - kerbY), 18 * s, 4 * s); }
    g.fillStyle = '#d6b22e'; for (let x = -400; x < AW + 400; x += 90) g.fillRect(LX(x), gy + 34 * s + shy, 46 * s, 5 * s);
    // blood on the street
    for (const dc of fight.decals) { g.fillStyle = 'rgba(110,0,0,.75)'; g.beginPath(); g.ellipse(LX(dc.x), gy + shy - 1, dc.r * s, dc.r * s * 0.28, 0, 0, 7); g.fill(); }

    // fatality timings
    const fat = d.ph === FPH.FATAL ? d.t : d.ph === FPH.OVER && d.res === 2 ? S.Fight.FATAL_T + d.t : -1;
    const wi = d.win, li = 1 - d.win;
    const once = (key, cond, fn) => { if (cond && !fight.once.has(key)) { fight.once.add(key); fn(); } };
    const fpos = d.f.map((f) => ({ x: f.x, y: f.y, show: true, P: null, char: 0 }));
    if (fat >= 0 && wi >= 0) {
      const W0 = d.f[wi], L0 = d.f[li], dirw = Math.sign(L0.x - W0.x) || 1;
      if (d.fk === 1) {
        // CAR CRUSH: point at the sky, and the car comes down on them
        fpos[wi].P = Object.assign(fPose({ act: FA.WIN, at: 0 }, 0), { aF: [3.05, 0.05], aB: [0.4, 1.8] });
        fpos[wi].x = L0.x - dirw * lerp(Math.abs(L0.x - W0.x), Math.max(Math.abs(L0.x - W0.x), carL * 0.55 + 40), E.outCubic(clamp(fat / 0.45, 0, 1))); // steps back out of the way
        const ft = clamp((fat - 0.55) / 0.42, 0, 1);
        const cy = fat < 0.55 ? 900 : 900 * (1 - E.inQuad(ft));
        const bounce = fat > 0.97 ? Math.max(0, Math.sin((fat - 0.97) * 14) * 26 * Math.exp(-(fat - 0.97) * 5)) : 0;
        once('crushhit', fat >= 0.97, () => {
          fight.shake = 34; fight.flash = 0.6; fsnd('crash', L0.x, 1); fsnd('splat', L0.x, 1); fsnd('boom', L0.x, 0.5);
          fBlood(L0.x, 20, 60, 1, 1.4); fBlood(L0.x, 20, 40, -1, 1.4); fGibs(L0.x, 30, 16, d.ids[li] ? nc(d.ids[li]) : '#888');
          fight.decals.push({ x: L0.x, r: 90 }); fight.excite = 1;
        });
        once('crushvoice', fat >= 0.2, () => Audio.voice(voiceOf(d.ids[li]), 'panic', cam.x, cam.y, 1));
        if (fat < 0.97) { fpos[li].P = Object.assign(fPose({ act: FA.DIZZY, at: 0 }, tt), { head: 0.6, aF: [2.9, 0.4], aB: [2.6, 0.5] }); }
        else fpos[li].show = false;
        // falling shadow, then the car
        if (fat < 0.97 && fat > 0.2) { const k = clamp((fat - 0.2) / 0.77, 0, 1); g.fillStyle = `rgba(0,0,0,${0.5 * k})`; g.beginPath(); g.ellipse(LX(L0.x), gy, carL * 0.5 * s * k, 10 * s * k, 0, 0, 7); g.fill(); }
        fight.crushCar = { x: L0.x, y: cy + bounce, smoke: fat > 0.97 };
        if (fat > 1.1 && Math.random() < dt * 12) fpart({ k: 'smoke', x: L0.x + rnd(-carL * 0.3, carL * 0.3), y: 60, vx: rnd(-10, 10), vy: rnd(30, 60), life: rnd(0.8, 1.6), sz: rnd(14, 26) });
      } else if (d.fk === 2) {
        // SKY HIGH: dash in, uppercut them into orbit, and wait
        const dash = clamp(fat / 0.25, 0, 1);
        fpos[wi].x = lerp(W0.x, L0.x - dirw * 52, E.outCubic(dash));
        const up = clamp((fat - 0.25) / 0.2, 0, 1);
        fpos[wi].P = fat < 0.25 ? fPose({ act: FA.WALK, at: 0 }, tt * 2) : fat < 0.9 ? fPose({ act: FA.CHP, at: 0.09 * up + 0.2 * (fat > 0.45 ? 1 : 0) }, tt) : fPose({ act: FA.WIN, at: 0 }, tt);
        once('skyhit', fat >= 0.36, () => { fight.shake = 22; fsnd('punch', L0.x, 1.4); fsnd('crash', L0.x, 0.4); fSpark(L0.x - dirw * 10, 120, true); fBlood(L0.x, 120, 25, 0, 1.2); Audio.voice(voiceOf(d.ids[li]), 'die', cam.x, cam.y, 1); });
        if (fat < 0.36) fpos[li].P = fPose({ act: FA.DIZZY, at: 0 }, tt);
        else if (fat < 2.05) {
          const ft = fat - 0.36;
          fpos[li].y = fat < 1.25 ? 1500 * ft - 600 * ft * ft : 1300 * (1 - E.inQuad(clamp((fat - 1.45) / 0.6, 0, 1)));
          fpos[li].P = Object.assign(fPose({ act: FA.FALL, at: 0.2 }, tt), { rot: -(fat * 9), ground: false });
          if (fat > 1.25 && fat < 1.45) fpos[li].show = false;
        } else fpos[li].show = false;
        once('skysplat', fat >= 2.05, () => { fight.shake = 30; fight.flash = 0.4; fsnd('splat', L0.x, 1.3); fsnd('boom', L0.x, 0.4); fBlood(L0.x, 8, 80, 1, 1.3); fBlood(L0.x, 8, 50, -1, 1.3); fGibs(L0.x, 12, 22, nc(d.ids[li])); fight.decals.push({ x: L0.x, r: 80 }); fight.excite = 1; });
      } else if (d.fk === 3) {
        // FIRE STARTER: one molotov, and they burn
        fpos[wi].P = fPose({ act: FA.HUBCAP, at: clamp(fat * 0.6, 0, 0.5) }, tt);
        const throwK = clamp((fat - 0.15) / 0.38, 0, 1);
        if (fat > 0.15 && fat < 0.53) {
          const bx = lerp(W0.x + dirw * 30, L0.x, throwK), by = 120 + Math.sin(throwK * Math.PI) * 90;
          g.save(); g.translate(LX(bx), gy - by * s + shy); g.rotate(throwK * 12); g.fillStyle = '#3d7a2a'; g.fillRect(-4 * s, -9 * s, 8 * s, 18 * s); g.fillStyle = '#ff9a2a'; g.fillRect(-2 * s, -15 * s, 4 * s, 6 * s); g.restore();
        }
        once('fireburst', fat >= 0.53, () => { fsnd('glass', L0.x, 1); fsnd('ignite', L0.x, 1); fight.flash = 0.35; Audio.voice(voiceOf(d.ids[li]), 'die', cam.x, cam.y, 1); fight.excite = 1; });
        const ch = clamp((fat - 0.6) / 1.5, 0, 1);
        if (fat >= 0.53 && fat < 2.4) {
          fpos[li].char = ch;
          fpos[li].P = fPose({ act: FA.DIZZY, at: 0 }, tt * 2.5, ch);
          if (Math.random() < dt * 60) fFire(L0.x, 20 + Math.random() * 140, 2);
        } else if (fat >= 2.4) {
          fpos[li].show = false;
          once('ash', true, () => { fsnd('land', L0.x, 1); fDust(L0.x, 16); for (let i = 0; i < 20; i++) fpart({ k: 'smoke', x: L0.x + rnd(-30, 30), y: rnd(10, 60), vx: rnd(-20, 20), vy: rnd(30, 70), life: rnd(1, 2), sz: rnd(14, 24) }); });
          // a smoking pile and a skull
          g.fillStyle = '#1a1412'; g.beginPath(); g.ellipse(LX(L0.x), gy + shy, 46 * s, 14 * s, 0, Math.PI, 0); g.fill();
          g.fillStyle = '#e8e0cc'; g.beginPath(); g.arc(LX(L0.x) + 8 * s, gy - 16 * s + shy, 9 * s, 0, 7); g.fill();
          g.fillStyle = '#1a1412'; g.fillRect(LX(L0.x) + 4 * s, gy - 18 * s + shy, 3 * s, 3 * s); g.fillRect(LX(L0.x) + 10 * s, gy - 18 * s + shy, 3 * s, 3 * s);
          if (Math.random() < dt * 20) fFire(L0.x, 10, 1);
        } else fpos[li].P = fPose({ act: FA.DIZZY, at: 0 }, tt);
      }
      once('fatvoice', fat >= 2.3, () => { Audio.announce('fatality', 'Fatality'); fight.flash = 0.25; });
    }
    // fighters (shadows first)
    for (let i = 0; i < 2; i++) {
      const f = d.f[i], q = fpos[i];
      if (!q.show) continue;
      g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(LX(q.x), gy + 2 + shy, 34 * s * (1 - Math.min(0.6, q.y / 400)), 7 * s, 0, 0, 7); g.fill();
    }
    const order = FMV[d.f[0].act] && !FMV[d.f[1].act] ? [1, 0] : [0, 1];
    // super flash: the screen goes dark behind the fighter doing it
    if (d.sf && d.frz > 0) {
      const k = clamp(d.frz / 10, 0, 1);
      g.fillStyle = `rgba(8,4,20,${0.62 * k})`; g.fillRect(0, 0, W, H);
      const sx0 = LX(d.f[d.sf - 1].x), sy0 = gy - 110 * s;
      const gr = g.createRadialGradient(sx0, sy0, 0, sx0, sy0, 240 * s); gr.addColorStop(0, `rgba(255,220,90,${0.55 * k})`); gr.addColorStop(1, 'rgba(255,120,20,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.save(); g.strokeStyle = `rgba(255,240,200,${0.5 * k})`; g.lineWidth = 2;
      for (let n = 0; n < 18; n++) { const a = n * 0.349 + tt * 3, r0 = 60 * s, r1 = (190 + 60 * Math.sin(n * 7 + tt * 20)) * s; g.beginPath(); g.moveTo(sx0 + Math.cos(a) * r0, sy0 + Math.sin(a) * r0); g.lineTo(sx0 + Math.cos(a) * r1, sy0 + Math.sin(a) * r1); g.stroke(); }
      g.restore();
    }
    for (const i of order) {
      const f = d.f[i], q = fpos[i];
      if (!q.show) continue;
      const P = q.P || fPose(f, tt + i * 0.7);
      const jit = d.frz > 0 && !d.sf && (f.act === FA.HURT || f.act === FA.FALL || f.act === FA.BLOCK || f.act === FA.CBLOCK || f.act === FA.THROWN) ? (((d.frz % 2) ? 1 : -1) * 3.5) : 0;
      g.save(); g.translate(LX(q.x + jit), gy - q.y * s + shy); g.scale(f.face * s, -s);
      let col = nc(d.ids[i]); if (col.length !== 7) col = '#888888';
      if (i === 1 && col === nc(d.ids[0])) col = S.PLAYER_COLORS.find((c) => c !== col && c.length === 7) || '#2f5fb3';
      if (!q.P && (f.act === FA.SUPER || f.act === FA.DASH || f.act === FA.SPIN || (f.act === FA.RISING && f.y > 10))) {
        g.save(); g.globalAlpha = alpha * 0.28; g.translate(-f.face * 26, -6); drawFighterBody(g, P, f.act === FA.SUPER ? '#ffcc33' : col, { skin: '#ffe9a8' }); g.restore();
      }
      drawFighterBody(g, P, col, { char: q.char, eyes: f.act === FA.DIZZY || f.act === FA.KO ? 'x' : '', hair: ['#2b1d14', '#5a3a1a', '#111', '#8a6a3a'][d.ids[i] % 4] });
      g.restore();
      // dizzy stars
      if (f.act === FA.DIZZY && fat < 0) {
        for (let k = 0; k < 3; k++) { const a = tt * 4 + (k * Math.PI * 2) / 3; g.fillStyle = '#ffe14a'; star5(g, LX(q.x + Math.cos(a) * 20), gy - (q.y + 165 + Math.sin(a) * 5) * s + shy, 6 * s, a); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); }
      }
      // a hubcap in hand while winding up
      if (f.act === FA.HUBCAP && f.at < FMV[FA.HUBCAP].s) drawHubcap(g, LX(q.x - f.face * 30), gy - 120 * s + shy, s, tt * 4);
      // YOU marker
      if (i === me0 && (d.ph === FPH.INTRO || d.ph === FPH.FIGHT && d.t < 3)) {
        const mx = LX(q.x), my = gy - (q.y + 205) * s + shy + Math.sin(tt * 6) * 4 * U;
        g.fillStyle = '#ffd21f'; g.beginPath(); g.moveTo(mx - 9 * U, my - 10 * U); g.lineTo(mx + 9 * U, my - 10 * U); g.lineTo(mx, my + 2 * U); g.closePath(); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 2; g.stroke();
        txt('YOU', mx, my - 22 * U, 18 * U, '#ffd21f', 'center');
      }
    }
    // hubcaps in flight
    for (const f of d.f) if (f.px > -900) {
      const hx = LX(f.px), hy = gy - 104 * s + shy;
      const gr = g.createRadialGradient(hx, hy, 0, hx, hy, 34 * s); gr.addColorStop(0, f.pstr ? 'rgba(255,170,60,.55)' : 'rgba(120,200,255,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(hx - 40 * s, hy - 40 * s, 80 * s, 80 * s);
      for (let k = 1; k <= 3; k++) { g.globalAlpha = alpha * (0.3 - k * 0.07); drawHubcap(g, hx - f.pvx * k * 12 * s, hy, s * 1.1, tt * 25 - k); }
      g.globalAlpha = alpha; drawHubcap(g, hx, hy, s * 1.15, tt * 25);
    }
    // the crushing car
    if (crush && fight.crushCar) { const cc = fight.crushCar; g.save(); g.translate(LX(cc.x), gy - cc.y * s + shy); g.scale(s, -s); drawSideCar(g, d.carT, d.carCol, carL, { night: night > 0.5 }); g.restore(); if (cc.y < 1) { g.fillStyle = '#0d0d0d'; rr(g, LX(cc.x) + carL * 0.45 * s, gy - 9 * s + shy, 18 * s, 8 * s, 3 * s); g.fill(); } }
    // particles
    for (let i = fight.parts.length - 1; i >= 0; i--) {
      const p = fight.parts[i];
      p.t += dt;
      if (p.t >= p.life) { fight.parts.splice(i, 1); continue; }
      const k = p.t / p.life;
      if (p.k === 'blood' || p.k === 'gib' || p.k === 'chip') {
        p.vy -= 950 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        if (p.y <= 0) {
          if (p.k === 'blood') { if (fight.decals.length < 80 && Math.random() < 0.5) fight.decals.push({ x: p.x, r: rnd(4, 10) }); fight.parts.splice(i, 1); continue; }
          p.y = 0; p.vy = Math.abs(p.vy) > 60 ? -p.vy * 0.3 : 0; p.vx *= 0.6; p.vr *= 0.6;
        }
      } else { p.x += (p.vx || 0) * dt; p.y += (p.vy || 0) * dt; }
      const X = LX(p.x), Y = gy - p.y * s + shy;
      if (p.k === 'blood') { g.fillStyle = p.col; g.fillRect(X - p.sz * s / 2, Y - p.sz * s / 2, p.sz * s, p.sz * s); }
      else if (p.k === 'gib') { g.save(); g.translate(X, Y); g.rotate(p.rot); g.fillStyle = '#000'; g.fillRect(-p.sz * s / 2 - 1, -p.sz * s / 3 - 1, p.sz * s + 2, p.sz * s * 0.66 + 2); g.fillStyle = p.col; g.fillRect(-p.sz * s / 2, -p.sz * s / 3, p.sz * s, p.sz * s * 0.66); g.restore(); }
      else if (p.k === 'chip') { g.fillStyle = '#fff6c0'; g.fillRect(X, Y, p.sz * s, p.sz * s); }
      else if (p.k === 'spark') {
        g.save(); g.globalAlpha = alpha * (1 - k);
        if (p.blk) { g.strokeStyle = '#9fe0ff'; g.lineWidth = 4 * s; g.beginPath(); g.arc(X, Y, p.sz * s * (0.4 + k * 0.7), 0, 7); g.stroke(); g.fillStyle = 'rgba(160,220,255,.6)'; star5(g, X, Y, p.sz * s * 0.5, p.rot); g.fill(); }
        else { g.fillStyle = '#fffbe0'; star5(g, X, Y, p.sz * s * (0.6 + k * 0.6), p.rot); g.fill(); g.strokeStyle = '#ffb21f'; g.lineWidth = 2; g.stroke(); g.strokeStyle = `rgba(255,255,255,${1 - k})`; g.lineWidth = 3 * s; g.beginPath(); g.arc(X, Y, p.sz * s * (0.5 + k * 1.4), 0, 7); g.stroke(); }
        g.restore();
      }
      else if (p.k === 'dust') { g.fillStyle = `rgba(190,180,160,${0.45 * (1 - k)})`; g.beginPath(); g.arc(X, Y, p.sz * s * (0.6 + k), 0, 7); g.fill(); }
      else if (p.k === 'smoke') { g.fillStyle = `rgba(40,40,44,${0.4 * (1 - k)})`; g.beginPath(); g.arc(X, Y, p.sz * s * (0.6 + k), 0, 7); g.fill(); }
      else if (p.k === 'fire') { // the same flame look as in the street
        const sp = flameSprites(), op = g.globalCompositeOperation, f = 1 - k, r = p.sz * s * (0.7 + k * 0.5);
        g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = alpha * Math.min(1, 0.3 + f * 0.8);
        g.drawImage(f > 0.5 ? sp.orange : sp.red, X - r * 1.5, Y - r * 1.5, r * 3, r * 3);
        if (f > 0.45) { g.globalAlpha = alpha * Math.min(1, (f - 0.45) * 2); const rc = r * (0.4 + (f - 0.45)); g.drawImage(sp.core, X - rc * 1.4, Y - rc * 1.4, rc * 2.8, rc * 2.8); }
        g.restore(); g.globalCompositeOperation = op;
      }
    }
    if (fight.flash > 0) { g.fillStyle = `rgba(255,255,255,${fight.flash * 0.6})`; g.fillRect(0, 0, W, H); }
    // night shading over the arena (the HUD stays bright)
    if (night > 0.05) { g.fillStyle = `rgba(10,14,40,${night * 0.25})`; g.fillRect(0, 0, W, H); }

    // ---------------- HUD
    const bw = W * 0.38, bh = 24 * U, by = 26 * U;
    for (let i = 0; i < 2; i++) {
      const f = d.f[i], left = i === 0, bx = left ? W / 2 - 46 * U - bw : W / 2 + 46 * U;
      fight.trail[i] = f.hp < fight.trail[i] ? damp(fight.trail[i], f.hp, 2.2, dt) : f.hp;
      g.fillStyle = '#000'; g.fillRect(bx - 4 * U, by - 4 * U, bw + 8 * U, bh + 8 * U);
      g.fillStyle = '#8a1010'; g.fillRect(bx, by, bw, bh);
      const tw = bw * clamp(fight.trail[i] / 100, 0, 1), hw2 = bw * clamp(f.hp / 100, 0, 1);
      g.fillStyle = '#ffd21f'; g.fillRect(left ? bx + bw - tw : bx, by, tw, bh);
      const hg = g.createLinearGradient(0, by, 0, by + bh); hg.addColorStop(0, '#7ef06a'); hg.addColorStop(1, '#1f9a2c');
      g.fillStyle = hg; g.fillRect(left ? bx + bw - hw2 : bx, by, hw2, bh);
      g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(bx, by + 2 * U, bw, 3 * U);
      const name = nm(d.ids[i]).replace('[BOT] ', '').toUpperCase() + (i === me0 ? ' (YOU)' : '');
      txt(name, left ? bx + bw - 6 * U : bx + 6 * U, by + bh / 2 + 1, 17 * U, '#fff', left ? 'right' : 'left', 3);
      // round wins
      for (let k = 0; k < S.Fight.WINS; k++) {
        const cx = left ? bx + bw - 12 * U - k * 26 * U : bx + 12 * U + k * 26 * U, cy = by + bh + 18 * U, won = d.wins[i] > k;
        g.fillStyle = '#000'; g.beginPath(); g.arc(cx, cy, 10 * U, 0, 7); g.fill();
        g.fillStyle = won ? '#ffd21f' : '#3a3a3a'; g.beginPath(); g.arc(cx, cy, 8 * U, 0, 7); g.fill();
        if (won) { g.fillStyle = '#b8860b'; star5(g, cx, cy, 5 * U, -Math.PI / 2); g.fill(); }
      }
    }
    // super meters, bottom corners
    for (let i = 0; i < 2; i++) {
      const f = d.f[i], left = i === 0, mw = W * 0.26, mh = 14 * U, my = H - (me0 >= 0 && d.ph <= FPH.FINISH ? 92 : 30) * U, mx = left ? 20 * U : W - 20 * U - mw;
      const full = f.meter >= 100;
      g.fillStyle = '#000'; g.fillRect(mx - 3 * U, my - 3 * U, mw + 6 * U, mh + 6 * U);
      g.fillStyle = '#1a2240'; g.fillRect(mx, my, mw, mh);
      const mwf = mw * clamp(f.meter / 100, 0, 1), mg = g.createLinearGradient(0, my, 0, my + mh);
      mg.addColorStop(0, full ? (tt * 4 % 1 < 0.5 ? '#fff6a0' : '#ffb020') : '#6fd0ff'); mg.addColorStop(1, full ? '#e06a10' : '#1f6ad0');
      g.fillStyle = mg; g.fillRect(left ? mx : mx + mw - mwf, my, mwf, mh);
      txt(full ? 'SUPER!' : 'SUPER', left ? mx + 4 * U : mx + mw - 4 * U, my - 10 * U, 13 * U, full ? '#ffd21f' : '#9fb3d9', left ? 'left' : 'right', 3);
      // combo counter
      const c = fight.combo[i];
      if (c) {
        c.t += dt;
        if (c.t > 1.6 || d.f[i].combo < c.n && d.f[i].combo <= 1 && c.t > 0.9) fight.combo[i] = null;
        else {
          const k = E.outBack(clamp(c.t / 0.18, 0, 1)), a = 1 - clamp((c.t - 1.2) / 0.4, 0, 1);
          g.save(); g.globalAlpha = alpha * a; g.translate(left ? 30 * U : W - 30 * U, H * 0.44); g.scale(k, k);
          txt(String(c.n), 0, 0, 64 * U, '#ffd21f', left ? 'left' : 'right', 6);
          txt('HITS', left ? 0 : 0, 44 * U, 26 * U, '#fff', left ? 'left' : 'right', 4);
          g.restore();
        }
      }
    }
    // the super's name
    if (fight.superT < 1.4) {
      fight.superT += dt;
      const k = E.outBack(clamp(fight.superT / 0.2, 0, 1)), a = 1 - clamp((fight.superT - 1) / 0.4, 0, 1);
      g.save(); g.globalAlpha = alpha * a; g.translate(fight.superBy === 0 ? W * 0.3 : W * 0.7, H * 0.26); g.scale(k, k); g.rotate(-0.05);
      txt('CARJACK RUSH!', 0, 0, 52 * U, '#ffd21f', 'center', 6); g.restore();
    }
    // clock
    txt(String(Math.max(0, d.ph === FPH.FIGHT ? d.rt : d.ph === FPH.INTRO ? S.Fight.ROUND_T : d.rt)), W / 2, by + bh / 2 + 2 * U, 40 * U, '#ffd21f', 'center');
    // big announcements
    const pop = (t0) => E.outBack(clamp((d.t - t0) / 0.3, 0, 1));
    const big = (str, sz, col, y, t0 = 0) => { const k = pop(t0); if (k <= 0) return; g.save(); g.translate(W / 2, y); g.scale(k, k); txt(str, 0, 0, sz * U, col, 'center', Math.max(4, sz / 9)); g.restore(); };
    const fname = (i) => nm(d.ids[i]).replace('[BOT] ', '').toUpperCase();
    if (d.ph === FPH.INTRO) {
      const fin = d.wins[0] === F_W1 && d.wins[1] === F_W1;
      if (d.t < 1.25) {
        if (d.round === 1) big(fname(0) + '  VS  ' + fname(1), 30, '#fff', H * 0.25);
        big(fin ? 'FINAL ROUND' : 'ROUND ' + d.round, 64, '#ffd21f', H * 0.4, 0.1);
      } else big('FIGHT!', 96, '#e3262c', H * 0.4, 1.25);
    } else if (d.ph === FPH.KO) {
      if (d.rw < 0) big('DRAW', 80, '#fff', H * 0.38);
      else {
        big(d.f[1 - d.rw].hp <= 0 && d.rt > 0 ? 'K.O.' : 'TIME', 96, '#e3262c', H * 0.36);
        if (d.t > 1) big(fname(d.rw) + ' WINS THE ROUND', 34, '#fff', H * 0.5, 1);
        if (d.flaw && d.t > 1.5) big('FLAWLESS VICTORY', 40, '#ffd21f', H * 0.58, 1.5);
      }
    } else if (d.ph === FPH.FINISH) {
      if (d.t > 0.45 && (tt * 3) % 1 < 0.8) big('FINISH HIM!', 84, '#e3262c', H * 0.33, 0.45);
    } else if (fat >= 2.3) {
      const k = clamp((fat - 2.3) / 0.25, 0, 1);
      g.save(); g.globalAlpha = alpha * k;
      txt(S.Fight.FATALS[d.fk], W / 2, H * 0.24, 34 * U, '#fff', 'center', 4);
      g.translate(W / 2, H * 0.36); g.scale(0.7 + 0.3 * E.outBack(k), 0.7 + 0.3 * E.outBack(k));
      txt('FATALITY', 0, 0, 110 * U, '#c80f14', 'center', 12);
      // dripping
      g.fillStyle = '#9c0b10'; for (let i = 0; i < 9; i++) { const R = S.rng(i * 13 + 5), x = (R() - 0.5) * 520 * U, len = (10 + R() * 50) * U * clamp((fat - 2.4) * 1.2, 0, 1); g.fillRect(x, 40 * U, 6 * U, len); g.beginPath(); g.arc(x + 3 * U, 40 * U + len, 4.5 * U, 0, 7); g.fill(); }
      g.restore();
    }
    if (d.ph === FPH.OVER) {
      const w = d.win;
      big(fname(w) + ' WINS', 56, '#ffd21f', d.res === 2 ? H * 0.52 : H * 0.36, 0.2);
      if (d.res !== 2 && d.t > 0.6) big(w === me0 ? 'THE CAR IS YOURS' : me0 >= 0 ? 'YOU LOST THE CAR' : '', 30, '#fff', H * 0.47, 0.6);
      else if (d.res === 2 && d.t > 0.6) big(w === me0 ? 'THE CAR IS YOURS' : me0 >= 0 ? 'YOU LOST THE CAR' : '', 28, '#fff', H * 0.6, 0.6);
    }
    // combo and special-move call-outs
    for (let i = fight.texts.length - 1; i >= 0; i--) {
      const tx = fight.texts[i]; tx.t += dt;
      if (tx.t > 1.5) { fight.texts.splice(i, 1); continue; }
      const k = E.outBack(clamp(tx.t / 0.25, 0, 1)), a = 1 - clamp((tx.t - 1.1) / 0.4, 0, 1);
      g.save(); g.globalAlpha = alpha * a;
      if (tx.fi !== undefined) { const f = d.f[tx.fi]; txt(tx.txt, LX(f.x), Math.max(90 * U, gy - (f.y + 200 + tx.t * 30) * s), 22 * U, tx.col, 'center', 3); }
      else { const left = tx.side === 0, x = left ? 24 * U : W - 24 * U; g.translate(x, H * 0.24 + (tx.big ? 40 * U : 0)); g.scale(k, k); txt(tx.txt, 0, 0, (tx.big ? 34 : 28) * U, tx.col, left ? 'left' : 'right', 4); }
      g.restore();
    }
    // controls
    if (me0 >= 0 && d.ph <= FPH.FINISH) {
      const face = d.f[me0].face, Fw = face > 0 ? '→' : '←', Bw = face > 0 ? '←' : '→';
      const touch = document.getElementById('touch').style.display === 'block';
      const mac = IS_MAC ? 'OPT' : 'CTRL';
      const LPn = touch ? 'LP' : 'A', HPn = touch ? 'HP' : 'S', LKn = touch ? 'LK' : 'Z', HKn = touch ? 'HK' : 'X', Pn = touch ? 'P' : 'PUNCH', Kn = touch ? 'K' : 'KICK';
      const DF = face > 0 ? '↘' : '↙', DB = face > 0 ? '↙' : '↘';
      g.save(); g.globalAlpha = alpha * 0.9;
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, H - 62 * U, W, 62 * U);
      if (d.ph === FPH.FINISH && d.win === me0) {
        txt('FINISH THEM:  ' + Bw + ' ' + Bw + ' +' + Kn + '  CAR CRUSH   ·   ↓ ↑ +' + Pn + '  SKY HIGH (close)   ·   ' + Fw + ' ' + Bw + ' ' + Fw + ' +' + Pn + '  FIRE STARTER', W / 2, H - 31 * U, 17 * U, '#ffd21f', 'center', 3);
      } else if (d.ph === FPH.FINISH) {
        txt('YOU ARE DAZED… THE OTHER GUY GETS TO FINISH IT', W / 2, H - 31 * U, 18 * U, '#ff9b9b', 'center', 3);
      } else {
        txt((touch ? '' : 'A / ' + mac + ' ') + 'LIGHT PUNCH · ' + HPn + ' HEAVY PUNCH · ' + (touch ? '' : 'Z / SPACE ') + 'LIGHT KICK · ' + HKn + ' HEAVY KICK · HOLD ' + Bw + ' BLOCK (' + DB + ' LOW) · ' + Fw + Fw + ' DASH · CLOSE ' + Fw + '+' + HPn + ' THROW', W / 2, H - 44 * U, 14 * U, '#fff', 'center', 3);
        txt('↓' + DF + Fw + '+' + Pn + ' HUBCAP TOSS · ' + Fw + '↓' + DF + '+' + Pn + ' RISING FIST · ↓' + DB + Bw + '+' + Kn + ' TIRE SPIN · FULL METER: ↓' + DF + Fw + '↓' + DF + Fw + '+' + Pn + ' CARJACK RUSH', W / 2, H - 20 * U, 14 * U, '#ffd21f', 'center', 3);
      }
      g.restore();
    }
    g.restore();
  }

  // ---------------- what everyone else sees: a brawl cloud by the car
  // ---------------- street brawls: the chalk ring on the street, and the crowd that gathers round it
  function drawBrawlRings(t) {
    for (const b of brawlMap.values()) {
      if (Math.abs(b.x - cam.x) > 1400 || Math.abs(b.y - cam.y) > 1400) continue;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(245,245,235,.8)'; ctx.lineWidth = 3; ctx.setLineDash([12, 8]); ctx.lineDashOffset = -t * 6;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      // the crowd: people packed round the outside, facing in, bouncing when someone gets hit hard
      const R = S.rng(b.id * 31 + 7), n = Math.floor((b.r * 2 * Math.PI) / 20);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (R() - 0.5) * 0.12, rr2 = b.r + 16 + R() * 10, hop = Math.abs(Math.sin(t * (6 + R() * 4) + i)) * 1.6;
        const x = b.x + Math.cos(a) * rr2, y = b.y + Math.sin(a) * rr2, face = a + Math.PI;
        const col = S.CAR_COLORS[Math.floor(R() * S.CAR_COLORS.length)], skin = SKINS[Math.floor(R() * SKINS.length)], hair = HAIRS[Math.floor(R() * HAIRS.length)];
        if (S.heightAt(map, x, y) > 0) continue; // nobody standing inside a building
        ctx.save(); ctx.translate(x, y); ctx.rotate(face); ctx.scale(1 + hop * 0.03, 1 + hop * 0.03);
        ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.ellipse(2, 2, 7, 6, 0, 0, 7); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, 4.6, 7.4, 0, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 0.8; ctx.stroke();
        if (i % 4 === 0) { ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(5 + hop, -4, 1.6, 0, 7); ctx.arc(5 + hop, 4, 1.6, 0, 7); ctx.fill(); } // fists in the air
        ctx.fillStyle = hair; ctx.beginPath(); ctx.arc(0.5, 0, 3.6, 0, 7); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
  }
  function drawBrawls(t, dt, st) {
    // brawl fighters: a ring of health over each head, and the hit numbers floating up
    for (const b of brawlMap.values()) {
      for (const [pid, m] of b.m) {
        const an = pedAnim.get(Math.abs(pid)); if (!an) continue;
        let x = an.x, y = an.y;
        if (pid === myId && pred.mode === 'ped') { x = pred.p.x + off.x; y = pred.p.y + off.y; }
        const fl = brawlFlash.get(pid);
        if (fl !== undefined) {
          const ft = fl + dt; if (ft > 1.2) brawlFlash.delete(pid); else brawlFlash.set(pid, ft);
          ctx.save(); ctx.globalAlpha = 0.85 * (1 - ft / 1.2); ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(x, y, 12 + ft * 10, 0, 7); ctx.stroke(); ctx.globalAlpha *= 0.5; ctx.beginPath(); ctx.arc(x, y, 9 + Math.sin(ft * 20) * 2, 0, 7); ctx.stroke(); ctx.restore();
        }
        const hx = x, hy = y - 36, f = clamp(m.hp / 100, 0, 1), col = f > 0.5 ? '#4cd964' : f > 0.25 ? '#ffcc00' : '#ff3b30';
        ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(hx, hy, 6.5, 0, 7); ctx.stroke();
        if (f > 0) { ctx.strokeStyle = m.st === BST.KO ? '#777' : col; ctx.beginPath(); ctx.arc(hx, hy, 6.5, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke(); }
        if (m.st === BST.BLOCK) { ctx.fillStyle = '#9fe0ff'; ctx.beginPath(); ctx.arc(hx, hy, 2.4, 0, 7); ctx.fill(); }
        if (pid === myId) { ctx.fillStyle = '#ffd21f'; ctx.beginPath(); ctx.moveTo(hx - 3.5, hy - 12); ctx.lineTo(hx + 3.5, hy - 12); ctx.lineTo(hx, hy - 8.5); ctx.fill(); }
      }
    }
    for (const [pid, sy] of says) {
      sy.t += dt; if (sy.t > 2.2) { says.delete(pid); continue; }
      const an = pedAnim.get(pid), row = st.P.find((r) => r[0] === pid);
      let x = sy.x, y = sy.y;
      if (pid === myId && pred.mode !== 'none') { const pp = pred.mode === 'car' ? pred.c : pred.p; x = pp.x + off.x; y = pp.y + off.y; }
      else if (row && !row[6] && an) { x = an.x; y = an.y; } else if (row && row[6]) { const cr = st.C.find((c) => c[0] === row[6]); if (cr) { x = cr[3]; y = cr[4]; } }
      const k = E.outBack(clamp(sy.t / 0.18, 0, 1)), a = 1 - clamp((sy.t - 1.8) / 0.4, 0, 1);
      ctx.save(); ctx.globalAlpha = a; ctx.translate(x + 10, y - 30); ctx.scale(k, k);
      ctx.font = `bold ${sy.kind === 2 ? 8 : 9}px system-ui, sans-serif`;
      const w = ctx.measureText(sy.txt).width + 10;
      ctx.fillStyle = sy.kind === 1 ? '#e8f0b8' : '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2;
      rr(ctx, -w / 2, -9, w, 15, 6); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-6, 5.5); ctx.lineTo(-10, 12); ctx.lineTo(-1, 5.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(sy.txt, 0, -1.5);
      ctx.restore();
    }
    for (let i = dmgTexts.length - 1; i >= 0; i--) {
      const d = dmgTexts[i]; d.t += dt;
      if (d.t > 0.9) { dmgTexts.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = 1 - clamp((d.t - 0.6) / 0.3, 0, 1);
      ctx.font = `bold ${d.txt === 'BLOCK' ? 7 : 9}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#000';
      ctx.strokeText(d.txt, d.x, d.y - d.t * 26); ctx.fillStyle = d.col; ctx.fillText(d.txt, d.x, d.y - d.t * 26); ctx.restore();
    }
    // dents in a car that bodies were thrown into: kept relative to the car once seen
    if (carDents.size) for (const r of st.C) {
      const dl = carDents.get(r[0]); if (!dl) continue;
      const [, , , x, y, a] = r, ca = Math.cos(a), sa = Math.sin(a);
      for (const dn of dl) {
        if (dn.lx === undefined) { const dx = dn.x - x, dy = dn.y - y; dn.lx = clamp(dx * ca + dy * sa, -18, 18); dn.ly = clamp(-dx * sa + dy * ca, -9, 9) * 0.7; }
        const px = x + dn.lx * ca - dn.ly * sa, py = y + dn.lx * sa + dn.ly * ca;
        ctx.save(); ctx.translate(px, py); ctx.rotate(a + dn.n);
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(0, 0, 4.5, 2.6, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(0.6, -0.4, 3.6, 3.6, 5.4); ctx.stroke();
        ctx.restore();
      }
    }
    const rows = (game && game.du) || [];
    for (const r of rows) {
      if (r[1] === myId || r[2] === myId) continue;
      const x = r[3], y = r[4];
      if (Math.abs(x - cam.x) > 1400 || Math.abs(y - cam.y) > 1400) continue;
      const R = S.rng(r[0]);
      for (let i = 0; i < 9; i++) {
        const a = i * 0.7 + t * (1.5 + R()), rad = 14 + R() * 10;
        ctx.fillStyle = i % 3 ? 'rgba(225,222,210,.88)' : 'rgba(190,186,175,.9)';
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * 16, y + Math.sin(a * 1.3) * 12, rad + Math.sin(t * 9 + i) * 3, 0, 7); ctx.fill();
      }
      // fists, feet and stars popping out
      const k = Math.floor(t * 6) % 4, a2 = Math.floor(t * 6) * 2.3;
      const px = x + Math.cos(a2) * 30, py = y + Math.sin(a2) * 24;
      ctx.fillStyle = '#000';
      if (k === 0) { ctx.beginPath(); ctx.arc(px, py, 7, 0, 7); ctx.fill(); ctx.fillStyle = '#d9a47a'; ctx.beginPath(); ctx.arc(px, py, 5.5, 0, 7); ctx.fill(); }
      else if (k === 1) { rr(ctx, px - 6, py - 4, 13, 8, 3); ctx.fill(); }
      else { ctx.fillStyle = '#ffe14a'; star5(ctx, px, py, 7, a2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2; ctx.stroke(); }
      if (Math.random() < dt * 4) Audio.play('punch', x, y, 0.5);
    }
  }

  // ================================================================ helicopters
  const heliAnim = new Map();
  function drawHelis(list, t, dt) {
    for (const h of list) {
      let an = heliAnim.get(h.id);
      if (!an) { an = { rot: 0, spin: 0 }; heliAnim.set(h.id, an); }
      const on = !!(h.fl & 128);
      an.spin = damp(an.spin, on ? 1 : 0, on ? 1.2 : 0.5, dt); // rotor spools up and winds down
      an.rot += dt * 32 * an.spin;
      // shadow, on the roof or street underneath
      const sx = h.x + sun.x * (h.z + 10) * 0.5, sy = h.y + sun.y * (h.z + 10) * 0.5, hb = S.heightAt(map, sx, sy);
      setWorld(hb);
      ctx.fillStyle = `rgba(0,0,0,${0.32 * clamp(1 - (h.z - hb) / 400, 0.4, 1)})`;
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(h.a); ctx.beginPath(); ctx.ellipse(0, 0, 26, 11, 0, 0, 7); ctx.fill(); ctx.fillRect(-48, -2.5, 30, 5);
      if (an.spin > 0.2) { ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(0, 0, 44, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
      ctx.restore();
      setWorld(h.z);
      const body = S.CAR_COLORS[h.col] || '#26282b';
      ctx.save(); ctx.translate(h.x, h.y); ctx.rotate(h.a);
      const sc = 1 + h.z / 260; ctx.scale(sc, sc); // up high it's close to the camera
      // skids
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(-15, -11); ctx.lineTo(17, -11); ctx.moveTo(-15, 11); ctx.lineTo(17, 11); ctx.stroke();
      // tail boom, fin and tail rotor
      ctx.fillStyle = '#000'; ctx.fillRect(-50, -3.5, 42, 7);
      ctx.fillStyle = shade(body, -0.15); ctx.fillRect(-49, -2.5, 40, 5);
      ctx.fillStyle = shade(body, -0.3); ctx.fillRect(-52, -7, 7, 14);
      ctx.strokeStyle = 'rgba(30,30,30,.85)'; ctx.lineWidth = 2; ctx.beginPath(); const tr = an.rot * 1.7; ctx.moveTo(-49 + Math.cos(tr) * 9, Math.sin(tr) * 9); ctx.lineTo(-49 - Math.cos(tr) * 9, -Math.sin(tr) * 9); ctx.stroke();
      // fuselage and canopy
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(2, 0, 24, 13, 0, 0, 7); ctx.fill();
      ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(2, 0, 22, 11, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.ellipse(-2, -4, 15, 4, 0, 0, 7); ctx.fill();
      ctx.fillStyle = sun.night > 0.5 ? '#2b3f58' : '#8fb9d6'; ctx.beginPath(); ctx.ellipse(14, 0, 9, 8, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillRect(14, -5, 4, 3);
      if (h.fl & (256 | 8192)) { ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(-4, 3, 12, 6, 0.5, 0, 7); ctx.fill(); }
      // main rotor: a blur when it's turning, two blades when it's still
      if (an.spin > 0.15) { ctx.fillStyle = `rgba(20,20,20,${0.16 * an.spin})`; ctx.beginPath(); ctx.arc(0, 0, 46, 0, 7); ctx.fill(); }
      ctx.strokeStyle = `rgba(25,25,25,${an.spin > 0.6 ? 0.45 : 0.95})`; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
      for (let k = 0; k < (an.spin > 0.6 ? 3 : 1); k++) {
        const ra = an.rot - k * 0.18;
        ctx.beginPath(); ctx.moveTo(Math.cos(ra) * 46, Math.sin(ra) * 46); ctx.lineTo(-Math.cos(ra) * 46, -Math.sin(ra) * 46); ctx.stroke();
      }
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, 7); ctx.fill();
      // a blinking light, and a searchlight at night
      if ((t * 1.5) % 1 < 0.12) { ctx.fillStyle = '#ff3030'; ctx.beginPath(); ctx.arc(-50, 0, 2.6, 0, 7); ctx.fill(); }
      ctx.restore();
      if (h.fl & 8192 && !(h.fl & 256) && Math.random() < dt * 18) { smoke(h.x - Math.cos(h.a) * 22, h.y - Math.sin(h.a) * 22, 8, 0.7); if (Math.random() < 0.3) fireP(h.x - Math.cos(h.a) * 8, h.y - Math.sin(h.a) * 8, 5, true); } // one hit taken: smoking
      if (h.fl & 256 && Math.random() < dt * 30) { smoke(h.x - Math.cos(h.a) * 10, h.y - Math.sin(h.a) * 10, 12, 0.85); fireP(h.x, h.y, 8, true); }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ================================================================ interpolation
  let INTERP = 90;
  function interp() {
    if (!snaps.length) return null;
    const rt = performance.now() + clockOff - INTERP;
    flushEvents(rt);
    let a = snaps[0], b = null;
    for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].tm <= rt) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    const t = b ? clamp((rt - a.tm) / (b.tm - a.tm), 0, 1) : 0;
    const src = b || a;
    const P = [], C = [], PR = [];
    for (const r of src.P) {
      const o = a.Pm.get(r[0]);
      if (!o || !b) { P.push(r); continue; }
      P.push([r[0], lerp(o[1], r[1], t), lerp(o[2], r[2], t), lerpA(o[3], r[3], t), r[4], r[5], r[6], r[7], r[8], lerp(o[9] || 0, r[9] || 0, t)]);
    }
    for (const r of src.C) {
      const o = a.Cm.get(r[0]);
      if (!o || !b) { C.push(r); continue; }
      C.push([r[0], r[1], r[2], lerp(o[3], r[3], t), lerp(o[4], r[4], t), lerpA(o[5], r[5], t), r[6], r[7], r[8], r[9], r[10], r[11] || 0, lerp(o[12] || 0, r[12] || 0, t), lerpA(o[13] || 0, r[13] || 0, t)]);
    }
    for (const r of src.PR) {
      const o = a.Rm.get(r[0]);
      if (!o || !b) { PR.push(r); continue; }
      PR.push([r[0], r[1], lerp(o[2], r[2], t), lerp(o[3], r[3], t)]);
    }
    const N = [];
    for (const r of src.N || []) {
      const o = a.Nm && a.Nm.get(r[0]);
      if (!o || !b) { N.push(r); continue; }
      N.push([r[0], lerp(o[1], r[1], t), lerp(o[2], r[2], t), lerpA(o[3], r[3], t), r[4], r[5]]);
    }
    return { P, C, PR, N };
  }

  // ================================================================ camera & projection
  const cam = { x: 0, y: 0, h: 560, ppu: 1, sx: 0, sy: 0 };
  let camLook = { x: 0, y: 0 };
  function proj(x, y, z) {
    const f = cam.h / (cam.h - z);
    return [W / 2 + (x - cam.x) * cam.ppu * f + cam.sx, H / 2 + (y - cam.y) * cam.ppu * f + cam.sy];
  }
  function setWorld(z) {
    const f = cam.h / (cam.h - (z || 0)), p = cam.ppu * f;
    ctx.setTransform(p, 0, 0, p, W / 2 - cam.x * p + cam.sx, H / 2 - cam.y * p + cam.sy);
  }

  // ================================================================ main loop
  let lastT = performance.now(), simAcc = 0;
  const pedAnim = new Map(), skidPrev = new Map();
  const carAnim = new Map(), doorAnim = new Map(), lastCar = new Map();
  const ghosts = [], falls = [], pools = [];
  let pkAnim = [];
  const hud = { score: 0, wk: null, wt: 9, hurt: 0, death: 0, prevHp: null, pulse: 0 };
  let engineSpeed = 0;
  // fists: the arm animation, and your own punches start on the key press
  // (a cop in a brawl has a negative id: its NPC is drawn under the positive one)
  function startKick(id) { const an = pedAnim.get(Math.abs(id)); if (an) an.kick = { t: 0 }; }
  function startGrab(id) { const an = pedAnim.get(Math.abs(id)); if (an) an.grab = { t: 0 }; }
  function startPunch(id) {
    let an = pedAnim.get(Math.abs(id));
    if (!an) return;
    an.pside = -(an.pside || 1);
    an.punch = { t: 0, side: an.pside };
  }
  const localFists = () => !!(me && me.al && !me.car && (me.w === S.FISTS || !(me.inv && me.inv[me.w] > 0)));
  let punchNext = 0, punchLast = 0, jumpNext = 0, shotNext = 0;
  let viewLag = null;
  function simTick() {
    if (!map || !net || !net.ok() || !myId) return;
    const k = readKeys();
    seq++;
    pending.push({ s: seq, k, vt: clockOff == null ? null : performance.now() + clockOff - INTERP });
    outbox.push([seq, k]);
    if (outbox.length >= 2) { net.send({ t: 'i', l: outbox, v: viewLag == null ? 0 : Math.round(viewLag) }); outbox = []; }
    if (pending.length > 180) pending.shift();
    // the pistol fires once per press (same rule as the game): remember the press until the gun is ready
    if (k & K.FIRE && !simTick.prevFire) simTick.pressAt = performance.now();
    const pull = me && me.w === 0 ? performance.now() - (simTick.pressAt ?? -1e9) < 350 : k & K.FIRE;
    if (pred.mode === 'ped' && pull && me && me.al && me.w >= 0 && me.w <= 3 && me.inv && me.inv[me.w] > 0 && performance.now() >= shotNext) {
      if (me.w === 0) simTick.pressAt = -1e9;
      const W = S.WEAPONS[me.w], now = performance.now();
      shotNext = now + W.rate * 1000;
      const a = pred.p.a, x = pred.p.x + Math.cos(a) * 14, y = pred.p.y + Math.sin(a) * 14, len = Math.min(W.range, 260);
      tracers.push({ x1: x, y1: y, x2: x + Math.cos(a) * len, y2: y + Math.sin(a) * len, life: 0.05, max: 0.05, w: me.w === 3 ? 1 : 1.6 });
      addP({ t: 'muzzle', x, y, a, life: 0.07, max: 0.07 });
      pulse(x, y, me.w === 3 ? 130 : 95, '255,205,130', 0.09);
      Audio.play(me.w === 3 ? 'shotgun' : me.w === 2 ? 'mg' : 'pistol', pred.p.x, pred.p.y);
      lastSfx.ownShot = now;
    }
    if (pred.mode === 'car' && k & K.FIRE && me && me.cw && me.cw[0] === 3 && me.cw[1] > 0 && !S.carAir(map, pred.c) && performance.now() >= jumpNext) {
      jumpNext = performance.now() + 350;
      pred.c.vz = S.CAR_JUMP; pred.c.z = (pred.c.z || 0) + 0.01; pending[pending.length - 1].j = true;
      Audio.play('jump', pred.c.x, pred.c.y, 1.3); Audio.play('whoosh', pred.c.x, pred.c.y);
    }
    // a punch on every tap, or a slower one every 0.6 s while held (same rhythm as the game)
    if (pred.mode === 'ped' && k & K.FIRE && localFists() && !myBrawl) {
      const now = performance.now(), held = simTick.prevFire;
      if (now >= punchNext && !(held && now - punchLast < 600)) { punchNext = now + 250; punchLast = now; startPunch(myId); Audio.play('whoosh', pred.p.x, pred.p.y, 0.8); }
    }
    simTick.prevFire = !!(k & K.FIRE);
    if (pred.mode === 'ped' && myBrawl) {
      // in a brawl: your own punches and kicks start on the key press (the game confirms the hits)
      const pr = k & ~(simTick.bk || 0); simTick.bk = k;
      if (bFree(myBrawlSt()) && !(k & K.BLOCK) && performance.now() >= punchNext) {
        if (pr & K.FIRE) { punchNext = performance.now() + 240; startPunch(myId); Audio.play('whoosh', pred.p.x, pred.p.y, 0.8); }
        else if (pr & K.HAND) { punchNext = performance.now() + 550; startKick(myId); Audio.play('whoosh', pred.p.x, pred.p.y, 1); }
      }
      brawlStep(pred.p, k);
    } else if (pred.mode === 'ped') {
      const vz0 = pred.p.vz || 0;
      S.stepPed(map, pred.p, k, DT);
      if (vz0 <= 0 && pred.p.vz > S.PED.jump + 50) Audio.play('boing', pred.p.x, pred.p.y); // off a trampoline
    } else if (pred.mode === 'car') {
      const g0 = !S.carAir(map, pred.c);
      S.stepCar(map, pred.c, k, DT); pushOffCars(pred.c, pred.id);
      if (g0 && pred.c.vz > 0) { Audio.play('jump', pred.c.x, pred.c.y, 1.3); Audio.play('whoosh', pred.c.x, pred.c.y); } // off a ramp
    }
    else if (fight.pred) fightTick(k);
    setTouchFight(inFight() || inBrawl());
  }
  // ---- automatic resolution: watch the time between frames. The shortest steady gap is the screen's own refresh;
  // when frames keep coming late (dropped), drop the resolution one step; when they've been on time for a while,
  // try one step back up (and if that drops frames again, wait longer before the next try)
  const perf = { iv: [], t0: 0, good: 0, upAt: 0, wait: 20000 };
  const SCALES = [1, 0.85, 0.72, 0.6, 0.5];
  function gfxUI() {
    for (const b of document.querySelectorAll('#gfx button')) b.classList.toggle('on', b.dataset.v === GFX);
    const n = document.getElementById('gfxnote');
    if (n) n.textContent = GFX === 'auto' ? (autoScale < 1 ? 'running at ' + Math.round(autoScale * 100) + '% resolution to keep it smooth' : 'full resolution, drops it if frames start to stutter') : GFX === 'sharp' ? 'always full resolution' : 'low resolution, no water shimmer';
  }
  for (const b of document.querySelectorAll('#gfx button')) b.addEventListener('click', () => { GFX = b.dataset.v; autoScale = 1; perf.wait = 20000; try { localStorage.setItem('cc_gfx', GFX); } catch {} resize(); gfxUI(); });
  setInterval(gfxUI, 2000);
  gfxUI();
  function perfWatch(now, ms) {
    if (GFX !== 'auto' || !joined || document.hidden || ms > 250) return;
    perf.iv.push(ms);
    if (now - perf.t0 < 2000) return;
    perf.t0 = now;
    const v = perf.iv.slice().sort((a, b) => a - b); perf.iv.length = 0;
    if (v.length < 6) return;
    // the screen's refresh: never slower than 60 Hz (if even the quickest frames are slower, we're just too slow)
    const vsync = Math.min(16.8, v[Math.floor(v.length * 0.1)]), avg = v.reduce((a, b) => a + b, 0) / v.length, late = v.filter((x) => x > vsync * 1.6).length / v.length;
    const i = SCALES.indexOf(autoScale);
    if ((avg > vsync * 1.3 || late > 0.15) && i < SCALES.length - 1) {
      autoScale = SCALES[i + 1]; resize(); perf.good = 0; perf.upAt = now + perf.wait; perf.wait = Math.min(180000, perf.wait * 2);
    } else if (avg < vsync * 1.07 && late < 0.03) {
      perf.good += 2000;
      if (i > 0 && perf.good >= 10000 && now > perf.upAt) { autoScale = SCALES[i - 1]; resize(); perf.good = 0; }
    } else perf.good = 0;
  }
  function frame(now) {
    requestAnimationFrame(frame);
    perfWatch(now, now - lastT);
    let dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    simAcc += dt;
    let n = 0;
    while (simAcc >= DT && n < 8) { simAcc -= DT; simTick(); n++; }
    if (n >= 8) simAcc = 0;
    if (map && snaps.length) render(dt);
    else idleScreen();
  }
  requestAnimationFrame(frame);

  function idleScreen() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0b0d'; ctx.fillRect(0, 0, W, H);
    const t = performance.now() / 1000;
    for (let i = 0; i < 30; i++) {
      const y = ((i * 97 + t * 60) % (H + 200)) - 100;
      ctx.fillStyle = i % 3 ? '#16161a' : '#1d1d22';
      ctx.fillRect(((i * 211) % W), y, 60 * DPR, 20 * DPR);
    }
    if (joined) txt('CONNECTING…', W / 2, H / 2, 40 * DPR, '#ffd21f', 'center');
  }

  function render(dt) {
    frameNo++;
    const st = interp();
    if (!st) return;
    // decay prediction offset
    const fo = Math.exp(-dt * 10);
    off.x *= fo; off.y *= fo; off.a *= fo;
    // focus
    let fx, fy, speed = 0, vx = 0, vy = 0;
    if (pred.mode === 'car') { fx = pred.c.x + off.x; fy = pred.c.y + off.y; vx = pred.c.vx; vy = pred.c.vy; speed = Math.hypot(vx, vy); }
    else if (pred.mode === 'ped') { fx = pred.p.x + off.x; fy = pred.p.y + off.y; }
    else if (deathCam) { fx = deathCam.x; fy = deathCam.y; }
    else { fx = cam.x || map.w * TILE / 2; fy = cam.y || map.h * TILE / 2; }
    const inHeli = pred.mode === 'car' && pred.c.t === S.HELI && pred.c.z > 20;
    const targetH = inHeli ? 1250 : myBrawl ? 390 : 560 + clamp(speed / 520, 0, 1) * 380;
    cam.h += (targetH - cam.h) * (1 - Math.exp(-dt * 2));
    camLook.x += (vx * 0.35 - camLook.x) * (1 - Math.exp(-dt * 3));
    camLook.y += (vy * 0.35 - camLook.y) * (1 - Math.exp(-dt * 3));
    if (!cam.x) { cam.x = fx; cam.y = fy; }
    const cf = 1 - Math.exp(-dt * 14);
    cam.x += (fx + camLook.x - cam.x) * cf; cam.y += (fy + camLook.y - cam.y) * cf;
    cam.ppu = Math.sqrt(W * H) / (cam.h * 1.45);
    shake *= Math.exp(-dt * 6);
    cam.sx = (Math.random() - 0.5) * shake * DPR; cam.sy = (Math.random() - 0.5) * shake * DPR;
    Audio.listener(cam.x, cam.y);
    // engine
    engineSpeed += ((pred.mode === 'car' ? speed : -1) - engineSpeed) * Math.min(1, dt * 6);
    const inBoat = pred.mode === 'car' && pred.c.t === S.BOAT;
    const inTank = pred.mode === 'car' && pred.c.t === S.TANK, kk = readKeys();
    Audio.engine(pred.mode === 'car' && pred.c.t !== S.HELI && !inBoat && !inTank, engineSpeed, !!(kk & K.UP));
    if (Audio.tank) Audio.tank(inTank, Math.max(0, engineSpeed), !!(kk & (K.UP | K.DOWN)), !!(kk & (K.LEFT | K.RIGHT)) && !(kk & K.TUR));
    Audio.boat(inBoat, engineSpeed, !!(readKeys() & (K.UP | K.DOWN)));
    {
      // the nearest helicopter with its rotor turning
      let hp = null, hd = 1e9;
      for (const r of st.C) if (r[1] === S.HELI && r[8] & 128) { const d = Math.hypot(r[3] - cam.x, r[4] - cam.y); if (d < hd) { hd = d; hp = [r[3], r[4]]; } }
      if (pred.mode === 'car' && pred.c.t === S.HELI && pred.c.hm >= 1) hp = [pred.c.x, pred.c.y];
      Audio.chopper(hp && Math.hypot(hp[0] - cam.x, hp[1] - cam.y) < 1600 ? hp : null);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b2252'; ctx.fillRect(0, 0, W, H); // deep water beyond the map's edge
    // ground
    setWorld(0);
    ctx.imageSmoothingEnabled = cam.ppu < 1;
    const hw = W / 2 / cam.ppu + 40, hh = H / 2 / cam.ppu + 40;
    const c0 = Math.max(0, Math.floor((cam.x - hw) / CS)), c1 = Math.min(Math.ceil(map.w / CH) - 1, Math.floor((cam.x + hw) / CS));
    const r0 = Math.max(0, Math.floor((cam.y - hh) / CS)), r1 = Math.min(Math.ceil(map.h / CH) - 1, Math.floor((cam.y + hh) / CS));
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) ctx.drawImage(getChunk(cx, cy).cv, cx * CS, cy * CS, CS + 0.6, CS + 0.6);
    ctx.imageSmoothingEnabled = true;
    drawWaterFx(c0, c1, r0, r1, performance.now() / 1000);
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) drawMarks(getChunk(cx, cy), cx * CS, cy * CS);
    updateSun();
    drawShadows(st);
    const vis = (x, y, m = 80) => Math.abs(x - cam.x) < hw + m && Math.abs(y - cam.y) < hh + m;
    const t = performance.now() / 1000;

    for (let i = pools.length - 1; i >= 0; i--) {
      const pl = pools[i]; pl.t += dt;
      const r = pl.r * E.outCubic(clamp(pl.t / 3, 0, 1));
      const draw = (g) => { g.fillStyle = 'rgba(96,0,0,.55)'; g.beginPath(); g.ellipse(pl.x, pl.y, r, r * 0.8, pl.rot, 0, 7); g.fill(); g.beginPath(); g.ellipse(pl.x + r * 0.5, pl.y - r * 0.2, r * 0.45, r * 0.38, pl.rot, 0, 7); g.fill(); };
      if (pl.t > 3.2) { stamp(pl.x, pl.y, pl.r * 1.6, draw); pools.splice(i, 1); continue; }
      draw(ctx);
    }
    // hazards (ground)
    for (const r of st.PR) {
      const [id, k, x, y] = r;
      if (!vis(x, y)) continue;
      if (k === 5) {
        const R = S.rng(id);
        ctx.save(); ctx.globalAlpha = clamp((r[4] === undefined ? 9 : r[4]) / 3, 0, 1); // fades over its last few seconds
        ctx.fillStyle = 'rgba(12,10,14,.85)';
        for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(x + (R() - 0.5) * 26, y + (R() - 0.5) * 26, 9 + R() * 8, 6 + R() * 6, R() * 3, 0, 7); ctx.fill(); }
        ctx.fillStyle = 'rgba(120,80,200,.18)'; ctx.beginPath(); ctx.ellipse(x - 4, y - 4, 8, 4, 0.6, 0, 7); ctx.fill();
        ctx.restore();
      } else if (k === 6) {
        ctx.fillStyle = '#2b2d2a'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5; ctx.stroke();
        if ((t * 2.5) % 1 < 0.4) { ctx.fillStyle = '#ff2b2b'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill(); }
      } else if (k === 4) {
        const gr = ctx.createRadialGradient(x, y, 0, x, y, 30);
        gr.addColorStop(0, 'rgba(255,140,40,.45)'); gr.addColorStop(1, 'rgba(255,80,20,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, 30, 0, 7); ctx.fill();
        if (Math.random() < dt * 30) fireP(x, y, rnd(5, 9));
      }
    }
    drawRaceWorld(t, dt, vis);
    stepChampagne(dt);
    // pickups
    for (let i = 0; i < pkDefs.length; i++) {
      const on = pkActive[i] === '1', pa = pkAnim[i] || (pkAnim[i] = { on, t: 9 });
      if (pa.on !== on) { pa.on = on; pa.t = 0; }
      pa.t += dt;
      const p = pkDefs[i];
      if (!vis(p.x, p.y)) continue;
      let sc = 1, al = 1;
      if (on) sc = pa.t < 0.45 ? Math.max(0, E.outBack(pa.t / 0.45)) : 1;
      else { if (pa.t > 0.3) continue; const k = pa.t / 0.3; sc = 1 + 0.8 * E.outCubic(k); al = 1 - k; }
      if (sc < 0.02) continue;
      ctx.save(); ctx.globalAlpha = al; ctx.translate(p.x, p.y); ctx.scale(sc, sc); ctx.translate(-p.x, -p.y);
      drawPickup(ctx, p, t);
      ctx.restore();
    }
    // cars
    const myCar = pred.mode === 'car' ? pred.id : 0;
    render.skidAmt = 0;
    const sirens = [], helis = [];
    const carRows = st.C.slice().sort((a, b) => ((b[1] === S.BOAT) * 2 + (b[8] & 1)) - ((a[1] === S.BOAT) * 2 + (a[8] & 1))); // boats first (bridges go over them), then wrecks
    // cars up at roof height (on a low roof, or jumping onto one) are drawn after the buildings
    const highCars = [];
    const drawCarRow = (r, late) => {
      let [id, ty, col, x, y, a, cvx, cvy, fl, drv, kb, up, cz, tur] = r;
      up = up || 0; cz = cz || 0;
      if (id === myCar) { x = pred.c.x + off.x; y = pred.c.y + off.y; a = pred.c.a + off.a; cvx = pred.c.vx; cvy = pred.c.vy; kb = readKeys(); cz = pred.c.z || 0; }
      if (ty === S.HELI) { helis.push({ id, col, x, y, a, z: cz, fl, vx: cvx, vy: cvy }); return; }
      if (!late && cz >= 20) { highCars.push(r); return; }
      const hb = S.heightAt(map, x, y), base = hb > 0 && cz >= hb - 6 ? hb : 0, air = cz - base; // what it stands on, and how far above that
      const C = S.CARS[ty];
      // skid marks
      const sp = Math.hypot(cvx, cvy), lat = Math.abs(-cvx * Math.sin(a) + cvy * Math.cos(a));
      const floats = C.kind === 'boat', tracks = C.kind === 'tank';
      const skidding = !floats && ((lat > 70 && sp > 60) || (kb & K.HAND && sp > 90) || (kb & K.DOWN && (cvx * Math.cos(a) + cvy * Math.sin(a)) > 150));
      if (floats && sp > 40 && !(fl & 1) && Math.random() < dt * (8 + sp / 30)) { // a white wake behind a moving boat
        const bx2 = x - Math.cos(a) * C.len * 0.5, by2 = y - Math.sin(a) * C.len * 0.5;
        addP({ t: 'smoke', x: bx2 + rnd(-5, 5), y: by2 + rnd(-5, 5), vx: -Math.sin(a) * rnd(-40, 40), vy: Math.cos(a) * rnd(-40, 40), life: rnd(0.6, 1.1), max: 1.1, sz: rnd(4, 8), dark: 0, col: 'rgba(235,245,255,0.9)' });
      }
      const ca = Math.cos(a), sa = Math.sin(a), bx = -C.len / 2 + 8;
      const w1x = x + bx * ca - (-C.wid / 2 + 3) * sa, w1y = y + bx * sa + (-C.wid / 2 + 3) * ca;
      const w2x = x + bx * ca - (C.wid / 2 - 3) * sa, w2y = y + bx * sa + (C.wid / 2 - 3) * ca;
      if (skidding && !(fl & 1) && air < 0.5) {
        const pv = skidPrev.get(id);
        if (pv && Math.hypot(pv[0] - w1x, pv[1] - w1y) < 40) {
          stamp(x, y, C.len, (g) => { g.strokeStyle = 'rgba(15,15,15,.32)'; g.lineWidth = 3.5; g.beginPath(); g.moveTo(pv[0], pv[1]); g.lineTo(w1x, w1y); g.moveTo(pv[2], pv[3]); g.lineTo(w2x, w2y); g.stroke(); });
          if (Math.random() < dt * 25) smoke((w1x + w2x) / 2, (w1y + w2y) / 2, 6, 0.1);
        }
        skidPrev.set(id, [w1x, w1y, w2x, w2y]);
        if (id === myCar) render.skidAmt = clamp((lat - 50) / 200 + (kb & K.HAND && sp > 90 ? 0.5 : 0), 0.25, 1);
      } else skidPrev.delete(id);
      // suspension and steering, worked out from how the car moves, eased so it never snaps
      let cs = carAnim.get(id);
      if (!cs) { cs = { a, v: 0, steer: 0, roll: 0, pitch: 0 }; carAnim.set(id, cs); }
      {
        const ddt = Math.max(dt, 1 / 240), fwd = cvx * ca + cvy * sa, om = S.angDiff(a, cs.a) / ddt;
        const alive = !(fl & 1);
        const steerT = alive && Math.abs(fwd) > 25 ? clamp(Math.atan((om * C.len * 0.6) / fwd), -0.55, 0.55) : cs.steer * 0.9;
        cs.steer = damp(cs.steer, steerT, 14, dt);
        cs.roll = damp(cs.roll, alive ? clamp((fwd * om) / 650, -1, 1) : 0, 6, dt);
        cs.pitch = damp(cs.pitch, alive ? clamp((fwd - cs.v) / ddt / 900, -1, 1) : 0, 7, dt);
        cs.v = fwd; cs.a = a;
      }
      if (carAnim.size > 600) carAnim.clear();
      if (!vis(x, y, 100)) return;
      const spr = carSprite(ty, col, fl & 1);
      // car jump: thump on landing, and draw it up in the air
      if (cs.air > 4 && air < 0.5) { Audio.play('land', x, y, 1.2); Audio.play('clunk', x, y, 0.8); for (let i = 0; i < 6; i++) smoke(x + rnd(-C.len / 2, C.len / 2), y + rnd(-C.wid / 2, C.wid / 2), 9, 0.25); shake = Math.max(shake, id === myCar ? 6 : 0); }
      cs.z = cz; cs.air = air;
      if (cz > 0.5) {
        setWorld(base); // the shadow falls on the street or on the roof it's over
        if (air > 0.5) { ctx.fillStyle = `rgba(0,0,0,${0.35 * clamp(1 - air / 120, 0.3, 1)})`; ctx.beginPath(); ctx.ellipse(x + 3 + air * 0.25, y + 3 + air * 0.25, C.len / 2, C.wid / 2, a, 0, 7); ctx.fill(); }
        setWorld(cz);
      }
      cs.fd = fl & 512 ? (cs.fd || 0) + dt : 0; // abandoned: fades away over 2 s
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      if (cs.fd) ctx.globalAlpha = clamp(1 - cs.fd / 1.9, 0, 1);
      if (air > 0.5) ctx.scale(1 + air / 140, 1 + air / 140); // up in the air: looks closer to the camera
      if (floats) ctx.rotate(Math.sin(t * 2.2 + id) * 0.025); // bobbing on the water
      if (fl & 4096) ctx.scale(1.06, 1.38); // squashed flat by the tank: wider and pancaked
      // tyres: front pair turns with the steering, peeking out past the body (not on a boat or a tank)
      if (!floats && !tracks) {
        const ax = [C.len / 2 - C.len * 0.22, -C.len / 2 + C.len * 0.22];
        if (C.kind === 'bus') ax.push(-C.len / 2 + C.len * 0.36);
        ctx.fillStyle = fl & 1 ? '#0b0b0b' : '#151515';
        ax.forEach((wx, i) => {
          for (const side of [-1, 1]) {
            ctx.save(); ctx.translate(wx, side * (C.wid / 2 - 1.2)); if (i === 0) ctx.rotate(cs.steer);
            rr(ctx, -4.6, -2.2, 9.2, 4.4, 1.5); ctx.fill(); ctx.restore();
          }
        });
      }
      const bodyX = -cs.pitch * 1.8, bodyY = -cs.roll * 2.4;
      ctx.drawImage(spr, -(C.len + 8) / 2 + bodyX, -(C.wid + 8) / 2 + bodyY, C.len + 8, C.wid + 8);
      if (fl & 4096) {
        // crumpled: dark creases across the roof and a ring of glass around it
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-C.len / 2, -C.wid / 2, C.len, C.wid);
        ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let k = 0; k < 5; k++) { const R2 = S.rng(id * 7 + k), x0 = (R2() - 0.5) * C.len; ctx.moveTo(x0, -C.wid / 2); ctx.lineTo(x0 + (R2() - 0.5) * 14, C.wid / 2); }
        ctx.stroke();
        ctx.fillStyle = 'rgba(200,225,240,.7)';
        for (let k = 0; k < 14; k++) { const R2 = S.rng(id * 13 + k), aa = R2() * 6.28, rr2 = 0.55 + R2() * 0.25; ctx.fillRect(Math.cos(aa) * C.len * rr2, Math.sin(aa) * C.wid * rr2, 1.6, 1.6); }
      }
      if (!(fl & 1) && (C.kind === 'tank' || C.kind === 'boat' || C.kind === 'firetruck')) { ctx.save(); ctx.translate(bodyX, bodyY); drawTurret(ctx, C, tur || 0); ctx.restore(); { const o = turretSeen.get(id); turretSeen.set(id, { x, y, a, tur: tur || 0, t: C.kind, at: performance.now(), bar: o ? o.bar : 0 }); } }
      if (up && !(fl & 1)) drawUpgrades(C, col, up, bodyX, bodyY, kb, Math.hypot(cvx, cvy), x, y, ca, sa, t);
      if (fl & 64) {
        const ph = Math.floor(t * 7) % 2;
        ctx.save(); ctx.translate(bodyX, bodyY);
        ctx.fillStyle = ph ? '#ff2a2a' : '#5a1010'; ctx.fillRect(-C.len * 0.06 - 0.5, -C.wid / 2 + 2.5, 5, (C.wid - 5) / 2);
        ctx.fillStyle = ph ? '#14246b' : '#3d7bff'; ctx.fillRect(-C.len * 0.06 - 0.5, 0, 5, (C.wid - 5) / 2);
        ctx.restore();
        sirens.push([x, y, ph]);
      }
      const tier = (fl >> 4) & 3;
      if (tier) {
        const R = S.rng(id * 31 + 7);
        ctx.save(); ctx.translate(bodyX, bodyY);
        for (let i = 0; i < tier * 4; i++) {
          ctx.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.35)' : 'rgba(150,150,150,.35)';
          ctx.beginPath(); ctx.ellipse((R() - 0.5) * C.len * 0.85, (R() < 0.5 ? -1 : 1) * (C.wid / 2 - 2 - R() * 3), 2 + R() * 3 * tier, 1 + R() * 1.5, R(), 0, 7); ctx.fill();
        }
        if (tier >= 2) {
          ctx.strokeStyle = 'rgba(220,235,255,.75)'; ctx.lineWidth = 0.6; ctx.beginPath();
          const wx = C.len * 0.17, wy = (R() - 0.5) * C.wid * 0.5;
          for (let i = 0; i < 5; i++) { ctx.moveTo(wx, wy); ctx.lineTo(wx + (R() - 0.5) * 8, wy + (R() - 0.5) * C.wid * 0.7); }
          ctx.stroke();
        }
        if (tier >= 3) { ctx.fillStyle = '#222'; ctx.fillRect(C.len / 2 - 3, -C.wid / 2 + 2, 3, 4.5); ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(-C.len / 2 + 2, -C.wid / 2 + 1, C.len * 0.3, C.wid - 2); }
        ctx.restore();
      }
      // the driver's door swings open and shut when someone gets in or out
      const dr = doorAnim.get(id);
      if (dr) {
        dr.t += dt;
        if (dr.t > 0.8) doorAnim.delete(id);
        else if (dr.t > 0) {
          const T = dr.t, open = T < 0.22 ? E.outCubic(T / 0.22) : T < 0.45 ? 1 : 1 - E.inOutCubic(Math.min(1, (T - 0.45) / 0.3));
          ctx.save(); ctx.translate(C.len * 0.16 + bodyX, -C.wid / 2 + 1 + bodyY); ctx.rotate(-open * 1.05);
          ctx.fillStyle = shade(S.CAR_COLORS[col], -0.25); ctx.fillRect(-C.len * 0.27, -1.6, C.len * 0.27, 3.2);
          ctx.fillStyle = 'rgba(28,41,56,.9)'; ctx.fillRect(-C.len * 0.2, -1.1, C.len * 0.12, 2.2);
          ctx.restore();
        }
      }
      if (!(fl & 1) && kb & K.DOWN && (cvx * ca + cvy * sa) > 20) { ctx.fillStyle = 'rgba(255,40,30,.75)'; ctx.fillRect(-C.len / 2 - 3, -C.wid / 2 + 1, 4, 6); ctx.fillRect(-C.len / 2 - 3, C.wid / 2 - 7, 4, 6); }
      ctx.restore();
      if (floats) deckOver(x, y, C.len / 2 + 6); // under a bridge: the deck goes back on top
      // your own vehicle: a little round health gauge off to its side
      if (id === myCar && me && me.car && me.car[12] != null) {
        const hpk = clamp(me.car[12] / 100, 0, 1), rx = x + Math.max(C.len, C.wid) * 0.5 + 12, ry = y - Math.max(C.len, C.wid) * 0.35 - 6, R0 = 7;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(rx, ry, R0 + 3, 0, 7); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(rx, ry, R0, 0, 7); ctx.stroke();
        ctx.strokeStyle = hpk > 0.6 ? '#5fe05a' : hpk > 0.3 ? '#ffc93a' : (t * 4) % 1 < 0.5 ? '#ff3b30' : '#a51a12';
        ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(rx, ry, R0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, hpk)); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 6px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('+', rx, ry + 0.4);
        ctx.restore();
      }
      if (cz > 0.5) setWorld(0);
      const fx2 = x + ca * C.len * 0.35, fy2 = y + sa * C.len * 0.35;
      if (fl & 2) { if (Math.random() < dt * 40) fireP(fx2 + rnd(-8, 8), fy2 + rnd(-8, 8), rnd(7, 12), true); if (Math.random() < dt * 14) smoke(fx2, fy2, 10, 0.8); }
      else if (fl & 4) { if (Math.random() < dt * 10) smoke(fx2, fy2, 7, 0.5); }
      else if (fl & 1) { if (Math.random() < dt * 3) smoke(x, y, 9, 0.8); }
    };
    for (const r of carRows) drawCarRow(r, false);
    const boatNow = pred.mode === 'car' && pred.c.t === S.BOAT;
    Audio.skid(pred.mode === 'car' && !boatNow ? render.skidAmt : 0); // no tyres on a boat: a hard turn throws spray instead
    Audio.boatSlide(boatNow ? render.skidAmt : 0);
    {
      let near = null, nd = 1e9;
      for (const [sx, sy, ph] of sirens) {
        const d = Math.hypot(sx - cam.x, sy - cam.y);
        if (d < nd) { nd = d; near = [sx, sy]; }
        pulse(sx, sy, 150, ph ? '255,40,40' : '60,110,255', 0.06);
      }
      Audio.siren(near && nd < 1100 && !fight.id && !fight.pred ? near : null); // no sirens over a fist fight
    }
    // people walking to a car door and climbing in
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const gh = ghosts[i]; gh.t += dt;
      if (gh.t < 0) continue;
      const D = 0.34;
      if (gh.t > D) { ghosts.splice(i, 1); continue; }
      const k = E.inOutCubic(gh.t / D), w = k < 0.7 ? k / 0.7 : 1, inn = k < 0.7 ? 0 : (k - 0.7) / 0.3;
      const gx = lerp(lerp(gh.x0, gh.dx, w), gh.x1, inn * 0.6), gy = lerp(lerp(gh.y0, gh.dy, w), gh.y1, inn * 0.6);
      drawPed(ctx, gx, gy, Math.atan2(gh.dy - gh.y0, gh.dx - gh.x0), gh.col, gh.t * 40, 1, 1 - inn, -1, false, 1 - 0.25 * inn);
    }
    // bodies falling over
    for (let i = falls.length - 1; i >= 0; i--) {
      const f = falls[i]; f.t += dt;
      const k = E.outCubic(clamp(f.t / 0.42, 0, 1));
      const fx = f.x - Math.cos(f.a) * 10 * k, fy = f.y - Math.sin(f.a) * 10 * k;
      if (f.t >= 0.42) {
        const col = f.col.length === 7 ? f.col : '#888888';
        stamp(fx, fy, 24, (g) => drawPed(g, fx, fy, f.a + Math.PI * 0.5 + rnd(-0.3, 0.3), shade(col, -0.25), 0, false, 1, -1, true));
        falls.splice(i, 1); continue;
      }
      drawPed(ctx, fx, fy, f.a + k * 1.5, f.col, 0, 0, 1, -1, false, 1, 1, 1 - 0.3 * k);
    }
    // peds (people up on building roofs are drawn after the buildings)
    const onRoofs = [];
    const drawOnePed = (r, late) => {
      let [id, x, y, a, hp, fl, car, w, mv, z] = r;
      if (car) return;
      z = z || 0;
      if (id === myId && pred.mode === 'ped') { x = pred.p.x + off.x; y = pred.p.y + off.y; a = pred.p.a + off.a; mv = pred.p.mv; z = pred.p.z || 0; }
      if (!late && z >= 24) { onRoofs.push(r); return; }
      let an = pedAnim.get(id);
      if (!an) { an = newPedAnim(x, y); pedAnim.set(id, an); }
      const d = Math.hypot(x - an.x, y - an.y);
      an.ph += d < 50 ? d * 0.28 : 0; an.x = x; an.y = y; an.a = a;
      const hb = S.heightAt(map, x, y);
      let base = id === myId && pred.mode === 'ped' ? pred.p.gz || 0 : z > 10 ? 0 : z;
      if (z >= hb - 6) base = Math.max(base, hb);
      const inAir = z > base + 1;
      an.amp = damp(an.amp, mv && !inAir ? 1 : 0, 12, dt); // stride eases in and out
      if (inAir !== an.air) { an.air = inAir; an.sq = 0; an.sqk = inAir ? 1 : 2; }
      an.sq += dt;
      let sqx = 1, sqy = 1;
      if (an.sqk === 1 && an.sq < 0.18) { const k = E.outCubic(an.sq / 0.18); sqx = lerp(1.2, 1, k); sqy = lerp(0.86, 1, k); }
      if (an.sqk === 2 && an.sq < 0.3) { const k = E.outBack(an.sq / 0.3); sqx = lerp(0.8, 1, k); sqy = lerp(1.18, 1, k); }
      if (an.ot < 0.32) { an.ot += dt; const k = 1 - E.outCubic(clamp(an.ot / 0.32, 0, 1)); x += an.ox * k; y += an.oy * k; }
      const stepN = Math.floor(an.ph / Math.PI);
      if (stepN !== an.sn) {
        an.sn = stepN;
        if (mv && z < 1) {
          Audio.step(x, y);
          // a little kick of dust from each footfall at a run
          if (an.amp > 0.7) { const ca2 = Math.cos(a), sa2 = Math.sin(a), sd = stepN % 2 ? 3 : -3; addP({ t: 'smoke', x: x - ca2 * 5 - sa2 * sd, y: y - sa2 * 5 + ca2 * sd, vx: -ca2 * 14, vy: -sa2 * 14, life: 0.45, max: 0.45, sz: 2.6, dark: 0.12 }); }
        }
      }
      if (!vis(x, y)) return;
      const info = roster.get(id) || { color: '#ccc' };
      let alpha = fl & 2 ? (id === myId ? 0.35 : 0.08) : 1;
      // shadow on whatever is underneath (a roof if standing on a car)
      const hgt = z - base + 12;
      ctx.globalAlpha = alpha * clamp(1.1 - (z - base) / 90, 0.35, 1);
      if (base > 0.5) setWorld(base);
      ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.ellipse(x + sun.x * hgt * 0.7, y + sun.y * hgt * 0.7, 8, 7, a, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      if (z > 0.5) setWorld(z); else if (base > 0.5) setWorld(0);
      if (fl & 4) { ctx.strokeStyle = `rgba(255,40,40,${0.5 + Math.sin(t * 10) * 0.3})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 15, 0, 7); ctx.stroke(); }
      if (an.punch) { an.punch.t += dt; if (an.punch.t > 0.3) an.punch = null; }
      if (an.kick) { an.kick.t += dt; if (an.kick.t > 0.4) an.kick = null; }
      if (an.grab) { an.grab.t += dt; if (an.grab.t > 0.35) an.grab = null; }
      const bm = brawlMember.get(id);
      an.bst = bm ? bm.st : -1;
      if (bm) {
        // in a brawl: always fists; floored, out cold or flying through the air: lying, a thrown body spinning
        if (bm.st === BST.FLY) { an.spin = (an.spin || 0) + dt * 13; a += an.spin; } else an.spin = 0;
        const flat = bm.st === BST.DOWN || bm.st === BST.KO || bm.st === BST.FLY;
        drawPed(ctx, x, y, a, info.color, an.ph, flat ? 0 : an.amp, alpha, S.FISTS, flat, 1, sqx, sqy, an.punch, an.look || (an.look = pedLook(id)), an, false);
        if (bm.st === BST.KO) for (let k2 = 0; k2 < 3; k2++) { const aa = t * 4 + k2 * 2.1; ctx.fillStyle = '#ffe14a'; star5(ctx, x + Math.cos(aa) * 11, y + Math.sin(aa) * 8 - 4, 3.2, aa); ctx.fill(); }
        return;
      }
      drawPed(ctx, x, y, a, info.color, an.ph, an.amp, alpha, id === myId && localFists() ? S.FISTS : w, false, 1 + Math.min(0.9, Math.max(0, z - base) * 0.009), sqx, sqy, an.punch, an.look || (an.look = pedLook(id)), an, !!(fl & 16) || (id === myId && pred.mode === 'ped' && !!(readKeys() & K.FIRE)));
      // a parachute: a striped canopy above them, swaying, and the lines down to the shoulders
      if (fl & 32 || (id === myId && pred.mode === 'ped' && pred.p.ch)) {
        const sw = Math.sin(t * 1.8 + id) * 0.12;
        setWorld(z + 46);
        ctx.save(); ctx.translate(x, y); ctx.rotate(a + Math.PI / 2 + sw);
        ctx.strokeStyle = 'rgba(30,30,30,.55)'; ctx.lineWidth = 0.8; ctx.beginPath(); for (const ex of [-17, -8, 8, 17]) { ctx.moveTo(ex, 2); ctx.lineTo(ex * 0.15, 0); } ctx.stroke();
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = i % 2 ? '#f2f2f2' : info.color; ctx.beginPath(); ctx.moveTo(0, 0);
          ctx.ellipse(0, 0, 21, 15, 0, Math.PI + (i / 6) * Math.PI, Math.PI + ((i + 1) / 6) * Math.PI); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.ellipse(-4, -6, 10, 4, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(0, 0, 21, 15, 0, Math.PI, Math.PI * 2); ctx.closePath(); ctx.stroke();
        ctx.restore();
      }
      if (z > 0.5) setWorld(0);
      if (fl & 1 && Math.random() < dt * 30) fireP(x + rnd(-6, 6), y + rnd(-6, 6), rnd(4, 8));
    };
    for (const r of st.N) {
      const [id, x, y, a, k, mv] = r;
      if (!vis(x, y)) continue;
      let an = pedAnim.get(id);
      if (!an) { an = newPedAnim(x, y); pedAnim.set(id, an); }
      const d = Math.hypot(x - an.x, y - an.y);
      an.ph += d < 50 ? d * 0.28 : 0; an.x = x; an.y = y;
      an.amp = damp(an.amp, mv ? 1 : 0, 10, dt);
      const cop = k & 1, gang = k & 8, armed = k & 16, owner = r[6] || 0, col = cop ? '#1d2b6b' : gang ? GANG_COL : PED_COLS[id % PED_COLS.length];
      if (k & 64) { drawSwimmer(x, y, a, col, cop, gang, an, mv, t, dt); continue; }
      const bcop = cop ? brawlMember.get(-id) : null;
      if (bcop) { // a cop fighting in a street brawl: fists, kicks, floored, flying
        if (an.punch) { an.punch.t += dt; if (an.punch.t > 0.3) an.punch = null; }
        if (an.kick) { an.kick.t += dt; if (an.kick.t > 0.4) an.kick = null; }
        if (an.grab) { an.grab.t += dt; if (an.grab.t > 0.35) an.grab = null; }
        an.bst = bcop.st;
        let aa = a; if (bcop.st === BST.FLY) { an.spin = (an.spin || 0) + dt * 13; aa += an.spin; } else an.spin = 0;
        const flat = bcop.st === BST.DOWN || bcop.st === BST.KO || bcop.st === BST.FLY;
        ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.ellipse(x + sun.x * 8.4, y + sun.y * 8.4, 8, 7, aa, 0, 7); ctx.fill();
        drawPed(ctx, x, y, aa, col, an.ph, flat ? 0 : an.amp, 1, S.FISTS, flat, 1.05, 1, 1, an.punch, an.look || (an.look = Object.assign(pedLook(id + 1000), { pants: '#141c40' })), an, false);
        if (!flat) { ctx.save(); ctx.translate(x, y); ctx.rotate(aa); ctx.fillStyle = '#121a3d'; ctx.beginPath(); ctx.arc(0.6, 0, 4.6, 0, 7); ctx.fill(); ctx.fillStyle = '#0b0f22'; ctx.fillRect(3.8, -3.2, 2.2, 6.4); ctx.fillStyle = '#e8c547'; ctx.fillRect(0, -0.9, 1.6, 1.8); ctx.restore(); }
        if (bcop.st === BST.KO) for (let k2 = 0; k2 < 3; k2++) { const q = t * 4 + k2 * 2.1; ctx.fillStyle = '#ffe14a'; star5(ctx, x + Math.cos(q) * 11, y + Math.sin(q) * 8 - 4, 3.2, q); ctx.fill(); }
        continue;
      }
      ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.ellipse(x + sun.x * 8.4, y + sun.y * 8.4, 8, 7, a, 0, 7); ctx.fill();
      if (owner) { // someone's crew: a ring in the boss's colour
        ctx.strokeStyle = nc(owner); ctx.globalAlpha = owner === myId ? 0.95 : 0.7; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.ellipse(x, y, 13.5, 12, 0, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      }
      drawPed(ctx, x, y, a, col, an.ph, an.amp, 1, cop ? 0 : gang && armed ? (k & 32 ? 2 : 0) : -1, false, cop ? 1.05 : gang ? 1.02 : 0.95, 1, 1, null, an.look || (an.look = Object.assign(pedLook(id + 1000), cop ? { pants: '#141c40', style: 0 } : gang ? { style: 0 } : {})), an, false);
      if (gang) {
        // red bandana knotted at the back of the head
        ctx.save(); ctx.translate(x, y); ctx.rotate(a);
        ctx.fillStyle = '#c4161c'; ctx.beginPath(); ctx.arc(0.4, 0, 4.4, Math.PI * 0.55, Math.PI * 1.45); ctx.lineTo(0.4, 0); ctx.fill();
        ctx.fillRect(-6.2, -1.2, 2.6, 2.4);
        ctx.restore();
      }
      if (cop) {
        // peaked police cap
        ctx.save(); ctx.translate(x, y); ctx.rotate(a);
        ctx.fillStyle = '#121a3d'; ctx.beginPath(); ctx.arc(0.6, 0, 4.6, 0, 7); ctx.fill();
        ctx.fillStyle = '#0b0f22'; ctx.fillRect(3.8, -3.2, 2.2, 6.4);
        ctx.fillStyle = '#e8c547'; ctx.fillRect(0, -0.9, 1.6, 1.8);
        ctx.restore();
      }
      if (k & 2 && Math.random() < dt * 30) fireP(x + rnd(-6, 6), y + rnd(-6, 6), rnd(4, 8));
    }
    drawBrawlRings(t);
    for (const r of st.P) drawOnePed(r, false);
    // projectiles
    for (const r of st.PR) {
      const [id, k, x, y] = r;
      if (k > 3 || !vis(x, y)) continue;
      if (k === 1 && r[4] > 6) continue; // a helicopter missile still up high: drawn after the buildings
      if (k === 1) {
        ctx.fillStyle = '#ddd'; ctx.beginPath(); ctx.arc(x, y, 3.6, 0, 7); ctx.fill();
        fireP(x, y, 4); if (Math.random() < 0.7) smoke(x, y, 5, 0.25);
      } else {
        const p = (t * 6 + id) % 1, h = Math.abs(Math.sin(t * 9 + id)) * 4;
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.arc(x + 2, y + 2, 3.5, 0, 7); ctx.fill();
        ctx.fillStyle = k === 2 ? '#3f5a2a' : '#6f8f3a'; ctx.beginPath(); ctx.arc(x, y - h, k === 2 ? 4 : 3.4, 0, 7); ctx.fill();
        if (k === 3) fireP(x, y - h, 3);
        void p;
      }
    }
    if (sun.lm) applyLights(st, dt); else pulses.length = 0;
    setWorld(0);
    stepParts(parts, dt); stepParts(partsHi, dt);
    drawParts(ctx, parts);
    drawBrawls(t, dt, st);
    // tracers & zaps
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i]; tr.life -= dt;
      if (tr.life <= 0) { tracers.splice(i, 1); continue; }
      ctx.strokeStyle = `rgba(255,236,160,${(tr.life / tr.max) * 0.9})`; ctx.lineWidth = tr.w;
      ctx.beginPath(); ctx.moveTo(tr.x1, tr.y1); ctx.lineTo(tr.x2, tr.y2); ctx.stroke();
    }
    for (let i = zaps.length - 1; i >= 0; i--) {
      const z = zaps[i]; z.life -= dt;
      if (z.life <= 0) { zaps.splice(i, 1); continue; }
      for (const [lw, col] of [[5, 'rgba(90,160,255,.45)'], [1.8, '#e8f4ff']]) {
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
        for (let j = 0; j + 3 < z.pts.length; j += 2) {
          const ax = z.pts[j], ay = z.pts[j + 1], bx2 = z.pts[j + 2], by2 = z.pts[j + 3];
          ctx.moveTo(ax, ay);
          const segs = 7;
          for (let s = 1; s <= segs; s++) {
            const f = s / segs, jit = s === segs ? 0 : 9;
            ctx.lineTo(lerp(ax, bx2, f) + rnd(-jit, jit), lerp(ay, by2, f) + rnd(-jit, jit));
          }
        }
        ctx.stroke();
      }
    }
    // buildings & trees
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawTall();
    if (highCars.length) { setWorld(0); for (const r of highCars) drawCarRow(r, true); ctx.setTransform(1, 0, 0, 1, 0, 0); }
    if (onRoofs.length) { setWorld(0); for (const r of onRoofs) drawOnePed(r, true); ctx.setTransform(1, 0, 0, 1, 0, 0); }
    drawHelis(helis, t, dt);
    // missiles from helicopters, up in the air
    for (const r of st.PR) {
      if (r[1] !== 1 || !(r[4] > 6)) continue;
      setWorld(r[4]);
      ctx.fillStyle = '#ddd'; ctx.beginPath(); ctx.arc(r[2], r[3], 4, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,170,60,.9)'; ctx.beginPath(); ctx.arc(r[2], r[3], 2.4, 0, 7); ctx.fill();
      if (Math.random() < 0.8) smoke(r[2], r[3], 5, 0.25);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // high particles (smoke, explosions) slightly elevated
    setWorld(20);
    drawParts(ctx, partsHi);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (sun.warm > 0.02 && !sun.lm) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(255,${(205 - sun.warm * 25) | 0},${(160 - sun.warm * 40) | 0},${(sun.warm * 0.42).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    // own jump / landing sounds, car radio
    if (pred.mode === 'ped') {
      const inAir = pred.p.z > (pred.p.gz || 0) + 0.5;
      if (inAir && !render.air) { Audio.play('jump'); if (pred.p.vz > 0 && !(pred.p.vz > S.PED.jump + 50)) Audio.play('hup', pred.p.x, pred.p.y, 0.9); } // hup! on a real jump (not off a trampoline or a ledge)
      if (!inAir && render.air) { Audio.play('land'); for (let i = 0; i < 5; i++) smoke(pred.p.x, pred.p.y, 4, 0.05); }
      render.air = inAir;
    } else render.air = false;
    const curCar = pred.mode === 'car' ? pred.id : 0;
    if (curCar !== render.radioCar) { render.radioCar = curCar; if (curCar) Radio.enter(curCar); else Radio.exit(); }
    // wasted: the colour drains out; hit: red flash at the edges
    hud.death = damp(hud.death, me && !me.al ? 1 : 0, me && !me.al ? 1.6 : 5, dt);
    if (hud.death > 0.01) {
      ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = `rgba(128,128,128,${(hud.death * 0.9).toFixed(3)})`; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(215,150,150,${(hud.death * 0.45).toFixed(3)})`; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    hud.hurt = damp(hud.hurt, 0, 2.6, dt);
    if (hud.hurt > 0.02) {
      const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
      gr.addColorStop(0, 'rgba(190,0,0,0)'); gr.addColorStop(1, `rgba(190,0,0,${(hud.hurt * 0.6).toFixed(3)})`);
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }
    // points floating up from where someone went down
    for (let i = popups.length - 1; i >= 0; i--) {
      const pp = popups[i]; pp.t += dt;
      if (pp.t > 1.2) { popups.splice(i, 1); continue; }
      const k = E.outCubic(pp.t / 1.2), [sx, sy] = proj(pp.x, pp.y, 0);
      ctx.globalAlpha = 1 - Math.max(0, (pp.t - 0.7) / 0.5);
      txt(pp.txt, sx, sy - (16 + 40 * k) * DPR, (16 + 6 * E.outBack(Math.min(1, pp.t / 0.25))) * DPR, pp.col, 'center', 2);
      ctx.globalAlpha = 1;
    }
    // police chasing you show as blue arrows at the screen edge
    if (me && me.wl) for (const r of st.N) {
      if (!(r[4] & 1)) continue;
      const [sx, sy] = proj(r[1], r[2], 0);
      if (sx > 0 && sx < W && sy > 0 && sy < H) continue;
      const dx = r[1] - cam.x, dy = r[2] - cam.y, ang = Math.atan2(dy, dx), m = 30 * DPR;
      const k2 = Math.min((W / 2 - m) / Math.abs(Math.cos(ang) || 1e-6), (H / 2 - m) / Math.abs(Math.sin(ang) || 1e-6));
      ctx.save(); ctx.translate(W / 2 + Math.cos(ang) * k2, H / 2 + Math.sin(ang) * k2); ctx.rotate(ang);
      ctx.fillStyle = Math.floor(performance.now() / 200) % 2 ? '#4f8dff' : '#ff4040'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2 * DPR;
      ctx.beginPath(); ctx.moveTo(12 * DPR, 0); ctx.lineTo(-8 * DPR, -9 * DPR); ctx.lineTo(-8 * DPR, 9 * DPR); ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.restore();
    }
    // badges over empty upgraded cars, so you can spot them
    {
      const tt = performance.now() / 1000;
      for (const r of st.C) {
        const up = r[11] || 0;
        if (!up || r[9] || r[8] & 1) continue;
        const [sx, sy] = proj(r[3], r[4], 0);
        if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
        const list = UP_BADGE.filter((b) => up & b[0]);
        const R = 7 * DPR, gap = 2 * R + 3 * DPR, by = sy - (30 + 4 * Math.sin(tt * 3 + r[0])) * cam.ppu;
        list.forEach(([, ch, col], i) => {
          const bx = sx + (i - (list.length - 1) / 2) * gap;
          ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(bx, by, R + 1.5 * DPR, 0, 7); ctx.fill();
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, R, 0, 7); ctx.fill();
          txt(ch, bx, by + 0.5 * DPR, 10 * DPR, '#fff', 'center', 1.5);
        });
      }
    }
    // name tags & arrows
    for (const r of st.P) {
      const [id, x, y, , , fl, car] = r;
      if (id === myId || fl & 2) continue;
      const [sx, sy] = proj(x, y, 0);
      const info = roster.get(id) || { name: '?', color: '#fff' };
      if (sx > -20 && sx < W + 20 && sy > -20 && sy < H + 20) {
        txt(info.name, sx, sy - (car ? 30 : 22) * cam.ppu, 12 * DPR, info.color, 'center', 2);
      } else {
        const dx = x - cam.x, dy = y - cam.y, d = Math.hypot(dx, dy);
        if (d > 2600) continue;
        const ang = Math.atan2(dy, dx), m = 52 * DPR; // big enough to spot at a glance
        const k2 = Math.min((W / 2 - m) / Math.abs(Math.cos(ang) || 1e-6), (H / 2 - m) / Math.abs(Math.sin(ang) || 1e-6));
        const ax = W / 2 + Math.cos(ang) * k2, ay = H / 2 + Math.sin(ang) * k2;
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang); ctx.globalAlpha = clamp(1.4 - d / 2600, 0.25, 0.9);
        ctx.fillStyle = info.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 4 * DPR; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(30 * DPR, 0); ctx.lineTo(-21 * DPR, -21 * DPR); ctx.lineTo(-11 * DPR, 0); ctx.lineTo(-21 * DPR, 21 * DPR); ctx.closePath(); ctx.stroke(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.moveTo(30 * DPR, 0); ctx.lineTo(-21 * DPR, -21 * DPR); ctx.lineTo(-11 * DPR, 0); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
    // district change
    if (pred.mode !== 'none' && frameNo % 20 === 0) {
      const dn = S.district(map, cam.x, cam.y);
      if (render.lastD && dn !== render.lastD) lowMsg = { txt: dn, t: 2.5 };
      render.lastD = dn;
    }
    drawHUD(dt);
    if (fight.pred || (fight.last && performance.now() - fight.endT < 450)) drawFight(dt);
  }

  // ---------------------------------------------------------------- sun & shadows
  // Time of day. DAY runs morning to late afternoon over a match, NIGHT stays dark,
  // DAY + NIGHT goes through dusk, night and dawn. Lamps and headlights fade on around sunset.
  const sun = { x: 0.3, y: 0.6, lx: -0.4, ly: -0.9, warm: 0, night: 0, lights: 0, lm: false, maxTl: 1, lastTl: 0, amb: [1, 1, 1], ambCss: '#fff' };
  let SHADOW = 'rgba(16,20,44,0.34)';
  function updateSun() {
    if (game.tl > sun.maxTl || game.tl > sun.lastTl + 5) sun.maxTl = game.tl;
    sun.lastTl = game.tl;
    const p = game.st === 'over' ? 1 : clamp(1 - game.tl / Math.max(60, sun.maxTl), 0, 1);
    const hour = todMode === 'night' ? 0.5 + 2 * p : todMode === 'cycle' ? (17 + 24 * p) % 24 : 8 + 9.5 * p;
    sun.hour = hour;
    const el = Math.sin(((hour - 6) / 24) * Math.PI * 2); // -1 at midnight, 1 at noon
    const day = smoothstep(-0.1, 0.2, el);
    sun.night = 1 - day;
    sun.lights = smoothstep(0.22, -0.04, el);
    const th = Math.PI * (0.15 + 0.7 * clamp((hour - 6) / 12, 0, 1));
    const len = Math.min(1.5, 0.3 + 0.9 * (1 - Math.max(0, el)));
    const mth = Math.PI * 0.3; // the moon throws faint shadows the other way
    sun.x = lerp(Math.cos(mth) * 0.55, Math.cos(th) * len, day); sun.y = lerp(Math.sin(mth) * 0.55, Math.sin(th) * len, day);
    const nl = Math.hypot(sun.x, sun.y) || 1;
    sun.lx = -sun.x / nl; sun.ly = -sun.y / nl;
    sun.warm = smoothstep(0.42, 0.02, el) * smoothstep(-0.16, 0, el);
    SHADOW = `rgba(16,20,44,${(0.34 * day + 0.13 * sun.night).toFixed(3)})`;
    let r = 255, g = 255, b = 255;
    r = lerp(r, 255, sun.warm * 0.6); g = lerp(g, 192, sun.warm * 0.6); b = lerp(b, 145, sun.warm * 0.6);
    r = lerp(r, 38, sun.night); g = lerp(g, 50, sun.night); b = lerp(b, 96, sun.night);
    sun.amb = [r / 255, g / 255, b / 255]; sun.ambCss = `rgb(${r | 0},${g | 0},${b | 0})`;
    sun.lm = sun.night > 0.03;
  }
  // colours of things drawn after the light map (buildings, trees, lamps) are darkened to match
  // ---------------------------------------------------------------- plants (the trees), cartoon top-down style
  // six kinds: a leafy rosette, a spiky palm, a round speckled bush, a fluffy clump, a scalloped flower-shaped shrub
  // and big tropical leaves. Each drawn once (three variations each) and kept, redrawn when the light changes.
  const PLANT_R = 44, PLANT_KINDS = 6, plantCache = new Map();
  let plantAmb = '';
  function plantSprite(kind, vari) {
    if (sun.ambCss !== plantAmb) {
      // the light moves slowly: only redraw once it has changed a noticeable amount
      const q = sun.lm ? sun.amb.map((v) => Math.round(v * 24)).join(',') : 'day';
      if (q !== plantAmb) { plantCache.clear(); plantAmb = q; }
    }
    const key = kind * 3 + vari;
    let c = plantCache.get(key);
    if (c) return c;
    const N = PLANT_R * 2 + 12; c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'); g.translate(N / 2, N / 2);
    drawPlant(g, kind, S.rng(1000 + key * 37), PLANT_R);
    plantCache.set(key, c); return c;
  }
  function drawPlant(g, kind, R, Rr) {
    const C = { deep: tint('#134a1b'), dark: tint('#1e6a24'), mid: tint('#2e8c2c'), light: tint('#4fae35'), lime: tint('#8acb47'), pale: tint('#b9e46a') };
    const leaf = (a, d0, len, wid, col, rib) => {
      g.save(); g.rotate(a); g.beginPath(); g.moveTo(d0, 0);
      g.quadraticCurveTo(d0 + len * 0.45, wid, d0 + len, 0); g.quadraticCurveTo(d0 + len * 0.45, -wid, d0, 0);
      g.fillStyle = col; g.fill(); g.strokeStyle = C.deep; g.lineWidth = 1; g.stroke();
      if (rib) { g.strokeStyle = rib; g.lineWidth = Math.max(0.8, wid * 0.12); g.beginPath(); g.moveTo(d0 + len * 0.05, 0); g.lineTo(d0 + len * 0.85, 0); g.stroke(); }
      g.restore();
    };
    const blob = (cx, cy, r, bumps, amp, col, stroke) => {
      g.beginPath();
      const ph = R() * 6;
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2, rr = r * (1 - amp + amp * Math.abs(Math.sin(t * bumps / 2 + ph)));
        i ? g.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr) : g.moveTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr);
      }
      g.closePath(); g.fillStyle = col; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke(); }
    };
    const T = Math.PI * 2;
    if (kind === 0) { // leafy rosette: layers of pointed leaves, darker outside, a bright star in the middle
      const n = 7 + ((R() * 2) | 0), o = R() * T;
      for (let i = 0; i < n; i++) leaf(o + (i / n) * T, 0, Rr, Rr * 0.34, C.dark, C.mid);
      for (let i = 0; i < n; i++) leaf(o + ((i + 0.5) / n) * T, 0, Rr * 0.78, Rr * 0.3, C.mid, C.light);
      for (let i = 0; i < 6; i++) leaf(o + (i / 6) * T + 0.3, 0, Rr * 0.48, Rr * 0.2, C.light, C.lime);
      for (let i = 0; i < 5; i++) leaf(o + (i / 5) * T, 0, Rr * 0.22, Rr * 0.09, C.lime, null);
    } else if (kind === 1) { // spiky palm / yucca: lots of long narrow leaves
      const n = 20 + ((R() * 6) | 0);
      for (let i = 0; i < n; i++) leaf(R() * T, 0, Rr * (0.75 + R() * 0.28), Rr * (0.09 + R() * 0.04), i % 3 ? C.mid : C.dark, C.light);
      for (let i = 0; i < n * 0.7; i++) leaf(R() * T, 0, Rr * (0.5 + R() * 0.3), Rr * 0.09, i % 2 ? C.light : C.lime, C.pale);
      g.fillStyle = C.deep; g.beginPath(); g.arc(0, 0, Rr * 0.08, 0, T); g.fill();
    } else if (kind === 2) { // round speckled bush
      blob(0, 0, Rr, 11, 0.08, C.dark, C.deep);
      blob(-Rr * 0.04, -Rr * 0.04, Rr * 0.9, 9, 0.07, C.mid, null);
      const gr = g.createRadialGradient(-Rr * 0.35, -Rr * 0.35, 0, -Rr * 0.2, -Rr * 0.2, Rr * 0.8);
      gr.addColorStop(0, 'rgba(190,240,110,.45)'); gr.addColorStop(1, 'rgba(190,240,110,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, Rr * 0.9, 0, T); g.fill();
      for (let i = 0; i < 70; i++) {
        const a = R() * T, d = Math.sqrt(R()) * Rr * 0.82;
        g.fillStyle = R() < 0.8 ? C.deep : C.lime;
        g.beginPath(); g.ellipse(Math.cos(a) * d, Math.sin(a) * d, 1 + R() * 1.6, 0.8 + R(), R() * 3, 0, T); g.fill();
      }
    } else if (kind === 3) { // fluffy clump: lots of little tufts of leaves
      blob(0, 0, Rr * 0.95, 13, 0.18, C.dark, C.deep);
      for (let i = 0; i < 46; i++) {
        const a = R() * T, d = Math.sqrt(R()) * Rr * 0.78, x = Math.cos(a) * d, y = Math.sin(a) * d, sz = Rr * (0.1 + R() * 0.08);
        const col = [C.mid, C.light, C.lime, C.dark][(R() * 4) | 0], o = R() * T;
        g.save(); g.translate(x, y);
        for (let j = 0; j < 5; j++) leaf(o + (j / 5) * T, 0, sz, sz * 0.38, col, null);
        g.restore();
      }
    } else if (kind === 4) { // scalloped, flower-shaped shrub: rings of rounded lobes
      blob(0, 0, Rr, 8, 0.22, C.dark, C.deep);
      blob(0, 0, Rr * 0.74, 7, 0.24, C.mid, C.dark);
      blob(0, 0, Rr * 0.48, 6, 0.26, C.light, C.mid);
      blob(0, 0, Rr * 0.22, 5, 0.3, C.lime, null);
      for (let i = 0; i < 24; i++) { const a = R() * T, d = Rr * (0.55 + R() * 0.35); g.fillStyle = C.deep; g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, 0.9 + R(), 0, T); g.fill(); }
    } else { // big tropical leaves with pale stripes
      const n = 6 + ((R() * 2) | 0), o = R() * T;
      for (let i = 0; i < n; i++) leaf(o + (i / n) * T, Rr * 0.05, Rr * 0.95, Rr * 0.4, i % 2 ? C.dark : C.mid, C.lime);
      for (let i = 0; i < n - 1; i++) leaf(o + ((i + 0.5) / (n - 1)) * T, 0, Rr * 0.68, Rr * 0.3, i % 2 ? C.light : C.mid, C.pale);
      for (let i = 0; i < 4; i++) leaf(o + (i / 4) * T + 0.4, 0, Rr * 0.38, Rr * 0.17, C.lime, C.pale);
    }
  }
  function tint(c) {
    if (!sun.lm) return c;
    let r, g, b;
    if (c[0] === '#') { const n = parseInt(c.slice(1), 16); r = n >> 16; g = (n >> 8) & 255; b = n & 255; }
    else [r, g, b] = c.match(/[\d.]+/g).map(Number);
    return `rgb(${(r * sun.amb[0]) | 0},${(g * sun.amb[1]) | 0},${(b * sun.amb[2]) | 0})`;
  }
  const lampFlick = (l, tt) => (l.bad && (Math.sin(tt * 23 + l.ph) > 0.55 || Math.sin(tt * 2.7 + l.ph) > 0.8) ? 0.2 : 1);

  // ---------------------------------------------------------------- night lighting
  // A half-resolution light map: dark blue ambient plus every light source, multiplied over the scene.
  const lm = document.createElement('canvas'), lmg = lm.getContext('2d');
  const pulses = [];
  function pulse(x, y, r, col, life) { if (sun.lm && pulses.length < 80) pulses.push({ x, y, r, col, life, max: life }); }
  const PK_GLOW = (k) => (k === 20 ? '255,90,90' : k === 21 ? '110,160,255' : k === 22 ? '255,60,60' : k === 23 ? '150,220,255' : k >= 30 ? '200,210,220' : '255,200,120');
  function applyLights(st, dt) {
    const LS = 0.5, lw = Math.ceil(W * LS), lh = Math.ceil(H * LS);
    if (lm.width !== lw || lm.height !== lh) { lm.width = lw; lm.height = lh; }
    const g = lmg, k = cam.ppu * LS, tt = performance.now() / 1000;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over'; g.fillStyle = sun.ambCss; g.fillRect(0, 0, lw, lh);
    g.globalCompositeOperation = 'lighter';
    const glow = (x, y, r, col, a) => {
      if (a < 0.01) return;
      const [sx, sy] = proj(x, y, 0), X = sx * LS, Y = sy * LS, R = r * k;
      if (X < -R || Y < -R || X > lw + R || Y > lh + R) return;
      const gr = g.createRadialGradient(X, Y, 0, X, Y, R);
      gr.addColorStop(0, `rgba(${col},${Math.min(1, a).toFixed(3)})`); gr.addColorStop(0.45, `rgba(${col},${(Math.min(1, a) * 0.45).toFixed(3)})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.fillRect(X - R, Y - R, 2 * R, 2 * R);
    };
    const L = sun.lights;
    // street lamps
    for (const l of map.lamps) {
      if (Math.abs(l.hx - cam.x) > W / cam.ppu || Math.abs(l.hy - cam.y) > H / cam.ppu) continue;
      glow(l.hx, l.hy, 175, '255,176,92', 0.8 * L * lampFlick(l, tt));
    }
    // headlight cones and tail lights on cars that have a driver
    const myCar = pred.mode === 'car' ? pred.id : 0;
    const cars = [];
    for (const r of st.C) {
      let [id, ty, , x, y, a, , , fl, drv, kb] = r;
      if (!drv || fl & 1) continue;
      if (id === myCar) { x = pred.c.x + off.x; y = pred.c.y + off.y; a = pred.c.a + off.a; kb = readKeys(); }
      cars.push([ty, x, y, a, kb]);
      const C = S.CARS[ty], ca = Math.cos(a), sa = Math.sin(a);
      const [sx, sy] = proj(x + ca * C.len * 0.5, y + sa * C.len * 0.5, 0);
      const R = 330 * k;
      g.save(); g.translate(sx * LS, sy * LS); g.rotate(a);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, R);
      gr.addColorStop(0, `rgba(255,244,214,${(0.95 * L).toFixed(3)})`); gr.addColorStop(0.5, `rgba(255,240,205,${(0.35 * L).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,240,205,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, -C.wid * 0.38 * k); g.lineTo(R, -R * 0.45); g.lineTo(R, R * 0.45); g.lineTo(0, C.wid * 0.38 * k); g.closePath(); g.fill();
      g.restore();
      glow(x - ca * C.len * 0.55, y - sa * C.len * 0.55, kb & K.DOWN ? 70 : 42, '255,30,25', (kb & K.DOWN ? 0.9 : 0.55) * L);
    }
    // fire, explosions, burning cars, rockets
    let n = 0;
    for (const arr of [parts, partsHi]) for (const p of arr) {
      if ((p.t === 'fire' || p.t === 'flame') && n++ % 3 === 0) glow(p.x, p.y, p.sz * 6, '255,130,45', 0.5 * (p.life / p.max) * (0.8 + 0.2 * Math.sin(tt * 30 + p.x)));
      else if (p.t === 'flash') glow(p.x, p.y, p.sz * 3.5, '255,210,150', p.life / p.max);
    }
    for (const r of st.PR) {
      if (r[1] === 4) glow(r[2], r[3], 75, '255,120,40', 0.5 * (0.8 + 0.2 * Math.sin(tt * 17 + r[0])));
      else if (r[1] === 1) glow(r[2], r[3], 70, '255,180,90', 0.85);
      else if (r[1] === 6) glow(r[2], r[3], 20, '255,40,40', (tt * 2.5) % 1 < 0.4 ? 0.8 : 0);
    }
    for (const r of st.C) if (r[8] & 2) glow(r[3], r[4], 150, '255,120,40', 0.65 * (0.75 + 0.25 * Math.sin(tt * 13 + r[0])));
    // muzzle flashes, blasts and bolts: short pulses that taper out
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]; p.life -= dt;
      if (p.life <= 0) { pulses.splice(i, 1); continue; }
      const f = p.life / p.max;
      glow(p.x, p.y, p.r * (0.8 + 0.2 * f), p.col, f * f);
    }
    // crates glow faintly so they can be found, and you can always see yourself
    for (let i = 0; i < pkDefs.length; i++) if (pkActive[i] === '1') glow(pkDefs[i].x, pkDefs[i].y, 60, PK_GLOW(pkDefs[i].k), 0.45 * sun.night);
    if (pred.mode === 'ped') glow(pred.p.x + off.x, pred.p.y + off.y, 160, '150,165,215', 0.38 * sun.night);
    if (pred.mode === 'car') glow(pred.c.x + off.x, pred.c.y + off.y, 110, '150,165,215', 0.25 * sun.night);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(lm, 0, 0, W, H);
    // the lamps themselves glow on top
    ctx.globalCompositeOperation = 'lighter';
    setWorld(0);
    for (const [ty, x, y, a, kb] of cars) {
      const C = S.CARS[ty], ca = Math.cos(a), sa = Math.sin(a);
      for (const side of [-1, 1]) {
        const hx = x + ca * (C.len / 2 - 1) - sa * side * (C.wid / 2 - 4), hy = y + sa * (C.len / 2 - 1) + ca * side * (C.wid / 2 - 4);
        const tx = x - ca * (C.len / 2 - 1) - sa * side * (C.wid / 2 - 4), ty2 = y - sa * (C.len / 2 - 1) + ca * side * (C.wid / 2 - 4);
        let gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, 9); gr.addColorStop(0, `rgba(255,250,225,${(0.9 * L).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,250,225,0)');
        ctx.fillStyle = gr; ctx.fillRect(hx - 9, hy - 9, 18, 18);
        const tb = kb & K.DOWN ? 1 : 0.55;
        gr = ctx.createRadialGradient(tx, ty2, 0, tx, ty2, 7); gr.addColorStop(0, `rgba(255,40,30,${(tb * L).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,40,30,0)');
        ctx.fillStyle = gr; ctx.fillRect(tx - 7, ty2 - 7, 14, 14);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function drawShadows(st) {
    const hw = W / 2 / cam.ppu + 300, hh = H / 2 / cam.ppu + 300;
    ctx.fillStyle = SHADOW;
    ctx.beginPath();
    // buildings: one combined path so overlapping shadows don't double up
    for (const b of map.buildings) {
      const x0 = b.x * TILE, y0 = b.y * TILE, x1 = x0 + b.w * TILE, y1 = y0 + b.h * TILE;
      if (x1 < cam.x - hw || x0 > cam.x + hw || y1 < cam.y - hh || y0 > cam.y + hh) continue;
      const dx = sun.x * b.lv * S.LEVEL, dy = sun.y * b.lv * S.LEVEL;
      const h = hull([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0 + dx, y0 + dy], [x1 + dx, y0 + dy], [x1 + dx, y1 + dy], [x0 + dx, y1 + dy]]);
      ctx.moveTo(h[0][0], h[0][1]);
      for (let i = 1; i < h.length; i++) ctx.lineTo(h[i][0], h[i][1]);
      ctx.closePath();
    }
    for (const tr of map.trees) {
      if (Math.abs(tr.x - cam.x) > hw || Math.abs(tr.y - cam.y) > hh) continue;
      const ox = tr.x + sun.x * 34, oy = tr.y + sun.y * 34;
      ctx.moveTo(ox + tr.r, oy); ctx.arc(ox, oy, tr.r, 0, Math.PI * 2);
    }
    ctx.fill();
    // trunks
    ctx.strokeStyle = SHADOW; ctx.lineWidth = 4;
    ctx.beginPath();
    for (const tr of map.trees) {
      if (Math.abs(tr.x - cam.x) > hw || Math.abs(tr.y - cam.y) > hh) continue;
      ctx.moveTo(tr.x, tr.y); ctx.lineTo(tr.x + sun.x * 30, tr.y + sun.y * 30);
    }
    ctx.stroke();
    ctx.lineWidth = 2.4; ctx.beginPath();
    for (const l of map.lamps) {
      if (Math.abs(l.x - cam.x) > hw || Math.abs(l.y - cam.y) > hh) continue;
      ctx.moveTo(l.x, l.y); ctx.lineTo(l.x + sun.x * 30, l.y + sun.y * 30); ctx.lineTo(l.hx + sun.x * 29, l.hy + sun.y * 29);
    }
    ctx.stroke();
    // cars
    const myCar = pred.mode === 'car' ? pred.id : 0;
    for (const r of st.C) {
      let [id, ty, , x, y, a] = r;
      if (id === myCar) { x = pred.c.x + off.x; y = pred.c.y + off.y; a = pred.c.a + off.a; }
      if (Math.abs(x - cam.x) > hw || Math.abs(y - cam.y) > hh) continue;
      const C = S.CARS[ty], k = C.h * 0.75;
      ctx.save(); ctx.translate(x + sun.x * k, y + sun.y * k); ctx.rotate(a);
      rr(ctx, -C.len / 2, -C.wid / 2, C.len, C.wid, 5); ctx.fillStyle = SHADOW; ctx.fill();
      ctx.restore();
    }
  }
  function wallLight(nx, ny) { return 0.5 + 0.5 * Math.max(0, nx * sun.lx + ny * sun.ly) + 0.12 * sun.warm; }
  // the chop shop's roller door, on the wall facing the camera (when the wall faces away the building hides it)
  function drawShopDoor(sh, zt) {
    const tx = -sh.wy, ty = sh.wx, half = 24, x0 = sh.dx - sh.wx * 0, y0 = sh.dy;
    const P = (u, z) => proj(x0 + tx * u, y0 + ty * u, z);
    const quad = (u0, z0, u1, z1, col) => { const a = P(u0, z0), b = P(u1, z0), c = P(u1, z1), d = P(u0, z1); ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.fill(); };
    const h = zt * 0.78;
    quad(-half - 3, 0, half + 3, h + 3, tint('#232326')); // frame
    quad(-half, 0, half, h, tint('#7b7f86')); // the roller door
    for (let z = 2.5; z < h; z += 3.2) quad(-half, z, half, z + 1, tint('#5c6066')); // slats
    // a tag sprayed across it: the only clue
    quad(-half * 0.7, h * 0.35, half * 0.1, h * 0.55, tint('#ff3caa'));
    quad(-half * 0.1, h * 0.5, half * 0.75, h * 0.66, tint('#28dce6'));
    quad(-half, 0, half, 1.2, tint('#ffd21f'));
  }
  function drawTall() {
    const hw = W / 2, hh = H / 2;
    const onScreen = (ax, ay, bx, by) => !(bx < 0 || by < 0 || ax > W || ay > H);
    // painter's order: farthest footprint from the camera first, so nearer roofs cover walls behind them
    const list = [];
    for (const it of tallList) {
      let d;
      if (it.kind === 't') d = Math.hypot(it.t.x - cam.x, it.t.y - cam.y) - it.t.r;
      else if (it.kind === 'l') { if (Math.abs(it.l.x - cam.x) > 1800 || Math.abs(it.l.y - cam.y) > 1300) continue; d = Math.hypot(it.l.x - cam.x, it.l.y - cam.y); }
      else {
        const b = it.b, x0 = b.x * TILE, y0 = b.y * TILE, x1 = x0 + b.w * TILE, y1 = y0 + b.h * TILE;
        if (x1 < cam.x - 2600 || x0 > cam.x + 2600 || y1 < cam.y - 1800 || y0 > cam.y + 1800) continue;
        d = Math.hypot(Math.max(x0 - cam.x, 0, cam.x - x1), Math.max(y0 - cam.y, 0, cam.y - y1));
      }
      it.d = d; list.push(it);
    }
    list.sort((a, b) => b.d - a.d);
    for (const it of list) {
      if (it.kind === 't') {
        const tr = it.t;
        const [gx, gy] = proj(tr.x, tr.y, 0);
        if (gx < -100 || gy < -100 || gx > W + 100 || gy > H + 100) continue;
        const [sx, sy] = proj(tr.x, tr.y, it.z);
        const f = cam.h / (cam.h - it.z), r = tr.r * cam.ppu * f;
        ctx.strokeStyle = tint('#4a3020'); ctx.lineWidth = 4 * cam.ppu; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(sx, sy); ctx.stroke();
        // a plant seen from above: which kind and which way it's turned come from where it stands
        const hsh = ((Math.round(tr.x) * 73856093) ^ (Math.round(tr.y) * 19349663)) >>> 0;
        const spr = plantSprite(hsh % PLANT_KINDS, (hsh >> 4) % 3), k = (r * 1.4) / PLANT_R;
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(((hsh >> 9) % 628) / 100); ctx.scale(k, k);
        ctx.drawImage(spr, -spr.width / 2, -spr.height / 2); ctx.restore();
        continue;
      }
      if (it.kind === 'l') {
        const l = it.l, [gx, gy] = proj(l.x, l.y, 0);
        if (gx < -60 || gy < -60 || gx > W + 60 || gy > H + 60) continue;
        const [tx, ty] = proj(l.x, l.y, it.z), [hx, hy] = proj(l.hx, l.hy, it.z - 1);
        ctx.strokeStyle = tint('#3a3e44'); ctx.lineCap = 'round';
        ctx.lineWidth = 2.4 * cam.ppu; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.lineWidth = 1.6 * cam.ppu; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.lineCap = 'butt';
        const on = sun.lights * lampFlick(l, performance.now() / 1000);
        ctx.fillStyle = on > 0.05 ? `rgb(255,${(200 + 40 * on) | 0},${(140 + 60 * on) | 0})` : tint('#a7acb2');
        ctx.beginPath(); ctx.ellipse(hx, hy, 4 * cam.ppu, 2.6 * cam.ppu, Math.atan2(hy - ty, hx - tx), 0, 7); ctx.fill();
        if (on > 0.05) {
          ctx.globalCompositeOperation = 'lighter';
          const R = 18 * cam.ppu, gr = ctx.createRadialGradient(hx, hy, 0, hx, hy, R);
          gr.addColorStop(0, `rgba(255,190,110,${(0.55 * on).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,190,110,0)');
          ctx.fillStyle = gr; ctx.fillRect(hx - R, hy - R, 2 * R, 2 * R);
          ctx.globalCompositeOperation = 'source-over';
        }
        continue;
      }
      const b = it.b, z = it.z;
      const x0 = b.x * TILE, y0 = b.y * TILE, x1 = (b.x + b.w) * TILE, y1 = (b.y + b.h) * TILE;
      const [ga, gb] = proj(x0, y0, 0), [gc, gd] = proj(x1, y1, 0);
      const [ra, rb] = proj(x0, y0, z), [rc, rd] = proj(x1, y1, z);
      if (!onScreen(Math.min(ga, ra), Math.min(gb, rb), Math.max(gc, rc), Math.max(gd, rd))) continue;
      const pal = ROOFS[b.st];
      const walls = [];
      if (cam.x < x0) walls.push([x0, y1, x0, y0, wallLight(-1, 0)]);
      if (cam.x > x1) walls.push([x1, y0, x1, y1, wallLight(1, 0)]);
      if (cam.y < y0) walls.push([x0, y0, x1, y0, wallLight(0, -1)]);
      if (cam.y > y1) walls.push([x1, y1, x0, y1, wallLight(0, 1)]);
      for (const [ax, ay, bx, by, lt] of walls) drawWall(ax, ay, bx, by, z, b, pal, lt);
      if (b.shop && b.shop.vis(cam)) drawShopDoor(b.shop, Math.min(z, 34));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(roofCanvas(b), ra, rb, rc - ra, rd - rb);
      ctx.imageSmoothingEnabled = true;
      if (sun.lm) {
        ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = sun.ambCss; ctx.fillRect(ra, rb, rc - ra, rd - rb);
        ctx.globalCompositeOperation = 'source-over';
        // red warning lights on tall buildings, pulsing in and out
        if (b.lv >= 4) {
          const ph = ((performance.now() / 1000) * 0.7 + (b.sd % 97) / 97) % 1, a = Math.pow(Math.sin(Math.PI * ph), 4) * sun.night;
          if (a > 0.02) {
            ctx.globalCompositeOperation = 'lighter';
            for (const [px, py] of [[ra + 5, rb + 5], [rc - 5, rd - 5]]) {
              const R = 14 * cam.ppu, gr = ctx.createRadialGradient(px, py, 0, px, py, R);
              gr.addColorStop(0, `rgba(255,40,30,${a.toFixed(3)})`); gr.addColorStop(1, 'rgba(255,40,30,0)');
              ctx.fillStyle = gr; ctx.fillRect(px - R, py - R, 2 * R, 2 * R);
            }
            ctx.globalCompositeOperation = 'source-over';
          }
        }
      }
    }
    void hw; void hh;
  }
  // ---------------------------------------------------------------- car upgrades
  function drawUpgrades(C, col, up, bx, by, kb, speed, wx, wy, ca, sa, t) {
    const L = C.len, Wd = C.wid;
    ctx.save(); ctx.translate(bx, by);
    if (up & S.UP.TURBO) {
      // racing stripes and twin exhausts
      ctx.fillStyle = S.CAR_COLORS[col] === '#e8e6df' ? 'rgba(200,30,30,.85)' : 'rgba(255,255,255,.8)';
      ctx.fillRect(-L / 2 + 2, -3.2, L - 4, 2); ctx.fillRect(-L / 2 + 2, 1.2, L - 4, 2);
      ctx.fillStyle = '#9aa0a6'; ctx.fillRect(-L / 2 - 3, -Wd / 2 + 4, 4, 2.2); ctx.fillRect(-L / 2 - 3, Wd / 2 - 6.2, 4, 2.2);
      if (kb & K.UP && speed > 30) {
        for (const side of [-1, 1]) {
          const fl = 5 + Math.random() * 9, y0 = side < 0 ? -Wd / 2 + 5.1 : Wd / 2 - 5.1;
          ctx.fillStyle = 'rgba(255,170,50,.85)'; ctx.beginPath(); ctx.moveTo(-L / 2 - 3, y0 - 1.8); ctx.lineTo(-L / 2 - 3 - fl, y0); ctx.lineTo(-L / 2 - 3, y0 + 1.8); ctx.fill();
          ctx.fillStyle = 'rgba(160,200,255,.9)'; ctx.beginPath(); ctx.moveTo(-L / 2 - 3, y0 - 0.9); ctx.lineTo(-L / 2 - 3 - fl * 0.45, y0); ctx.lineTo(-L / 2 - 3, y0 + 0.9); ctx.fill();
        }
        if (Math.random() < 0.3) pulse(wx - ca * L * 0.6, wy - sa * L * 0.6, 50, '255,160,60', 0.08);
      }
    }
    if (up & S.UP.ARMOR) {
      // bolted steel plating and window grilles
      ctx.strokeStyle = 'rgba(40,44,48,.95)'; ctx.lineWidth = 2.2;
      ctx.strokeRect(-L / 2 + 1.5, -Wd / 2 + 1.5, L - 3, Wd - 3);
      ctx.fillStyle = '#c9ccd0';
      for (let i = 0; i < 6; i++) { const x = -L / 2 + 3 + (i * (L - 6)) / 5; ctx.fillRect(x - 0.6, -Wd / 2 + 0.9, 1.2, 1.2); ctx.fillRect(x - 0.6, Wd / 2 - 2.1, 1.2, 1.2); }
      ctx.strokeStyle = 'rgba(30,30,30,.9)'; ctx.lineWidth = 0.8; ctx.beginPath();
      for (let i = -2; i <= 2; i++) { ctx.moveTo(L * 0.1, i * Wd * 0.14); ctx.lineTo(L * 0.24, i * Wd * 0.14); }
      ctx.stroke();
    }
    if (up & S.UP.GRIP) {
      // rear wing
      ctx.fillStyle = '#1b1b1b'; ctx.fillRect(-L / 2 - 1, -Wd / 2 - 1, 3.5, Wd + 2);
      ctx.fillStyle = shade(S.CAR_COLORS[col], -0.3); ctx.fillRect(-L / 2 + 2.5, -Wd / 2 + 2, 2, 2.5); ctx.fillRect(-L / 2 + 2.5, Wd / 2 - 4.5, 2, 2.5);
    }
    if ((up & S.UP.ARMED) && C.kind !== 'boat' && C.kind !== 'tank') { // (their guns are on the turret)
      // gun barrels on the bonnet
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(L * 0.28, -Wd / 2 + 3, L * 0.26, 2.2); ctx.fillRect(L * 0.28, Wd / 2 - 5.2, L * 0.26, 2.2);
      ctx.fillStyle = '#555'; ctx.fillRect(L * 0.24, -Wd / 2 + 2.2, 4, 3.8); ctx.fillRect(L * 0.24, Wd / 2 - 6, 4, 3.8);
    }
    ctx.restore();
  }
  const UP_BADGE = [[1, 'T', '#ff9c2b'], [2, 'A', '#7fa9ff'], [4, 'G', '#5fd36a'], [8, 'W', '#ff4b4b']];
  function drawWall(ax, ay, bx, by, z, b, pal, lt) {
    const A = proj(ax, ay, 0), B = proj(bx, by, 0), A2 = proj(ax, ay, z), B2 = proj(bx, by, z);
    ctx.fillStyle = tint(shade(pal.wall, Math.min(0.15, lt - 1)));
    ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(B2[0], B2[1]); ctx.lineTo(A2[0], A2[1]); ctx.closePath(); ctx.fill();
    // area check to skip windows on very thin walls
    const area = Math.abs((B[0] - A[0]) * (A2[1] - A[1]) - (B[1] - A[1]) * (A2[0] - A[0]));
    if (area < 200) return;
    const len = Math.hypot(bx - ax, by - ay), nw = Math.max(1, Math.floor(len / 22));
    const P = (t2, zz) => proj(ax + (bx - ax) * t2, ay + (by - ay) * t2, zz);
    for (let l = 0; l < b.lv; l++) {
      const z0 = (l + 0.28) * S.LEVEL, z1 = (l + 0.72) * S.LEVEL;
      for (let i = 0; i < nw; i++) {
        const h = S.hash(b.sd + i, l * 31 + (ax | 0) + (ay | 0), 7);
        if (l === 0 && h < 0.12) continue;
        const t0 = (i + 0.22) / nw, t1 = (i + 0.78) / nw;
        const p1 = P(t0, z0), p2 = P(t1, z0), p3 = P(t1, z1), p4 = P(t0, z1);
        // more windows are lit after dark, and they glow
        const lit = h > 0.9 - 0.42 * sun.night;
        ctx.fillStyle = lit ? (sun.lm ? (h > 0.97 ? '#bfe0ff' : '#ffd77e') : '#e6cf72') : tint(lt > 0.8 ? '#2f4152' : '#1f2b37');
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]); ctx.closePath(); ctx.fill();
      }
    }
    // roofline edge
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(A2[0], A2[1]); ctx.lineTo(B2[0], B2[1]); ctx.stroke();
  }

  // ---------------------------------------------------------------- pickups & icons
  function drawPickup(g, p, t) {
    const k = p.k, bob = Math.sin(t * 3 + p.id) * 1.5;
    if (k <= 8) {
      // weapons: just the gun, floating and turning slowly, with its shadow on the ground and a faint glow to spot it by
      const lift = 6 + Math.sin(t * 2.2 + p.id) * 2.5;
      g.save(); g.translate(p.x, p.y);
      const gl = g.createRadialGradient(0, 0, 2, 0, 0, 23); // (guns on the ground: 20% smaller than they were)
      gl.addColorStop(0, 'rgba(255,214,90,.28)'); gl.addColorStop(1, 'rgba(255,214,90,0)');
      g.fillStyle = gl; g.beginPath(); g.arc(0, 0, 23, 0, 7); g.fill();
      g.save(); g.translate(4, 4); g.rotate(t * 0.9 + p.id); g.scale(0.7, 0.7); g.globalAlpha = 0.28; g.filter = 'brightness(0)'; icon(g, k, 0, 0, 1); g.restore();
      g.translate(0, -lift * 0.35); g.rotate(t * 0.9 + p.id);
      icon(g, k, 0, 0, 0.7);
      g.restore();
      return;
    }
    g.save(); g.translate(p.x, p.y + bob);
    g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(-11, -9, 26, 24);
    if (k >= 22 && k <= 23) {
      g.rotate(t * 1.5);
      const col = k === 22 ? '#ff3b3b' : '#9fd8ff';
      g.fillStyle = col; g.globalAlpha = 0.25 + 0.15 * Math.sin(t * 6); g.beginPath(); g.arc(0, 0, 18, 0, 7); g.fill(); g.globalAlpha = 1;
      g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, 12, 0, 7); g.fill();
      g.strokeStyle = col; g.lineWidth = 2; g.stroke();
      g.rotate(-t * 1.5);
      icon(g, k, 0, 0, 0.7);
    } else {
      g.rotate(Math.sin(t * 1.3 + p.id) * 0.25);
      const metal = k >= 30;
      g.fillStyle = metal ? '#6f7880' : k === 20 ? '#e9e9e4' : k === 21 ? '#3d6fb4' : '#9b6a36';
      g.fillRect(-12, -12, 24, 24);
      g.fillStyle = 'rgba(0,0,0,.25)';
      if (!metal && k < 20) { g.fillRect(-12, -5, 24, 1.5); g.fillRect(-12, 4, 24, 1.5); }
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.5; g.strokeRect(-12, -12, 24, 24);
      g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(-12, -12, 24, 2);
      icon(g, k, 0, 0, 0.42);
    }
    g.restore();
  }
  // vector icons, drawn centred at x,y; s ~ 1 => ~44px wide
  // ---------------------------------------------------------------- weapon & pickup icons
  // Drawn once at 4x size with shading (metal, wood, glass, polymer), then reused as images: sharp at any size and
  // cheap enough to spin on every pickup. Side views, muzzle to the right. Coordinates fit in ±40 × ±32.
  const ICON_CACHE = new Map();
  function icon(g, k, x, y, s) {
    let c = ICON_CACHE.get(k);
    if (!c) {
      const R = 4;
      c = document.createElement('canvas'); c.width = 80 * R; c.height = 64 * R;
      const cg = c.getContext('2d');
      cg.scale(R, R); cg.translate(40, 32); cg.lineJoin = 'round'; cg.lineCap = 'round';
      drawIcon(cg, k);
      ICON_CACHE.set(k, c);
    }
    const sm = g.imageSmoothingEnabled; g.imageSmoothingEnabled = true;
    g.drawImage(c, x - 40 * s, y - 32 * s, 80 * s, 64 * s);
    g.imageSmoothingEnabled = sm;
  }
  function drawIcon(g, k) {
    const INK = '#0c0d10';
    const lin = (x0, y0, x1, y1, stops) => { const gr = g.createLinearGradient(x0, y0, x1, y1); stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c)); return gr; };
    const rad = (x, y, r0, r1, stops) => { const gr = g.createRadialGradient(x, y, r0, x, y, r1); stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c)); return gr; };
    const poly = (pts) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); };
    const fillOut = (fill, lw = 1.3) => { g.fillStyle = fill; g.fill(); g.strokeStyle = INK; g.lineWidth = lw; g.stroke(); };
    const rect = (x, y, w, h, r, fill, lw) => { rr(g, x, y, w, h, r); fillOut(fill, lw); };
    const line = (x0, y0, x1, y1, col, w = 0.8) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
    const steel = (y0, y1) => lin(0, y0, 0, y1, ['#f4f6f8', '#b9bec5', '#7b8189', '#4a4f56']);
    const gunmetal = (y0, y1) => lin(0, y0, 0, y1, ['#6d737b', '#3c4148', '#25292e', '#15181b']);
    const wood = (y0, y1) => lin(0, y0, 0, y1, ['#c98a4f', '#9a5f2c', '#6e3f19', '#4a290f']);
    const glow = (x, y, r, col) => { g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = rad(x, y, 0, r, [col, 'rgba(0,0,0,0)']); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore(); };
    const flame = (x, y, len, w) => {
      g.save(); g.translate(x, y);
      g.fillStyle = lin(0, 0, len, 0, ['#fff7c0', '#ffd23a', '#ff7a1a', 'rgba(220,40,10,0)']);
      g.beginPath(); g.moveTo(0, -w * 0.35); g.quadraticCurveTo(len * 0.45, -w, len, -w * 0.15); g.quadraticCurveTo(len * 0.7, 0, len, w * 0.25); g.quadraticCurveTo(len * 0.45, w, 0, w * 0.35); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,230,.9)'; g.beginPath(); g.ellipse(len * 0.18, 0, len * 0.18, w * 0.2, 0, 0, 7); g.fill();
      g.restore();
    };
    // a compact semi-automatic pistol
    const pistol = (dark) => {
      // grip: textured polymer, raked back
      poly([[-12, -1], [-3.5, -1], [-1, 12.5], [-9.5, 13.5]]); fillOut(lin(-12, 0, 0, 0, dark ? ['#2a2a2c', '#141416'] : ['#3b3936', '#1b1a19']));
      g.fillStyle = 'rgba(255,255,255,.09)'; for (let yy = 1.5; yy < 12; yy += 2.2) for (let xx = -9.6; xx < -3; xx += 2.2) g.fillRect(xx + yy * 0.18, yy, 0.9, 0.9);
      // frame and trigger guard
      rect(-12.5, -3.5, 22, 4.2, 1, gunmetal(-3.5, 1));
      g.beginPath(); g.moveTo(-2.5, 0.6); g.quadraticCurveTo(-2, 6.5, 4.5, 6); g.quadraticCurveTo(7.5, 5.4, 7, 0.6); g.strokeStyle = INK; g.lineWidth = 2.6; g.stroke(); g.strokeStyle = '#3a3f45'; g.lineWidth = 1.2; g.stroke();
      line(1.5, 0.8, 2.6, 4.2, '#9aa0a7', 1.1); // trigger
      // slide with rear serrations, ejection port, sights
      rect(-14, -10, 29, 7, 1.4, dark ? lin(0, -10, 0, -3, ['#c7ccd2', '#8a9098', '#555b62']) : steel(-10, -3));
      for (let i = 0; i < 5; i++) line(-12 + i * 1.3, -9, -12 + i * 1.3, -4, 'rgba(0,0,0,.45)', 0.6);
      rect(0, -9, 6, 3.2, 0.4, '#202328', 0.8);
      line(-13, -9.3, 14, -9.3, 'rgba(255,255,255,.75)', 0.7);
      rect(12.2, -11.4, 1.6, 1.6, 0.3, '#22252a', 0.6); rect(-13.2, -11.4, 2.4, 1.6, 0.3, '#22252a', 0.6);
      rect(14.4, -8.6, 1.4, 3, 0.3, '#08090a', 0.6); // muzzle
    };
    switch (k) {
      case 0: g.translate(-1, 0); g.scale(1.25, 1.25); pistol(); break;
      case 1:
        g.save(); g.translate(-7, -5); g.scale(1.05, 1.05); pistol(true); g.restore();
        g.save(); g.translate(5, 5); g.scale(1.05, 1.05); pistol(); g.restore();
        break;
      case 2: { // assault machine gun: skeleton stock, receiver, curved magazine, shrouded barrel
        poly([[-31, -5], [-17, -6], [-17, 1], [-29, 6], [-33, 6]]); fillOut(gunmetal(-6, 6));
        g.fillStyle = '#0c0d10'; poly([[-28, -2.5], [-20, -3], [-20, -0.5], [-27, 2.5]]); g.fill();
        rect(-18, -8, 24, 10, 1.5, gunmetal(-8, 2)); // receiver
        rect(-14, -11.5, 14, 3.6, 1, gunmetal(-11.5, -8)); // top rail / carry handle
        for (let i = 0; i < 6; i++) line(-13 + i * 2.2, -11, -13 + i * 2.2, -8.5, 'rgba(255,255,255,.18)', 0.5);
        g.beginPath(); g.moveTo(-3, 2); g.quadraticCurveTo(-1, 10, 3, 17); g.lineTo(9, 15.5); g.quadraticCurveTo(5, 9, 4.5, 2); g.closePath(); fillOut(lin(-3, 0, 9, 0, ['#4a4f56', '#22262b'])); // magazine
        line(-1, 4, 3.5, 14, 'rgba(255,255,255,.18)', 0.7);
        poly([[-14, 1.5], [-8.5, 1.5], [-7, 12], [-12.5, 12.5]]); fillOut(lin(-14, 0, -7, 0, ['#3b3936', '#1b1a19'])); // grip
        g.beginPath(); g.moveTo(-8, 2); g.quadraticCurveTo(-7, 6, -3, 6); g.strokeStyle = INK; g.lineWidth = 1.6; g.stroke();
        rect(6, -7.5, 15, 6.5, 1.2, lin(0, -7.5, 0, -1, ['#5c6168', '#2a2e33', '#16191c'])); // handguard
        for (let i = 0; i < 4; i++) rect(8 + i * 3.3, -5.6, 1.8, 2.6, 0.6, '#0b0c0e', 0.4);
        rect(21, -5.6, 9, 2.6, 0.6, steel(-5.6, -3)); rect(29.5, -6.4, 3.5, 4.2, 0.6, '#1c1f23', 0.8); // barrel, flash hider
        rect(18, -11, 1.8, 3.6, 0.4, '#1c1f23', 0.6); // front sight
        line(-17, -7.2, 5, -7.2, 'rgba(255,255,255,.35)', 0.6);
        break;
      }
      case 3: { // pump shotgun: wood stock and forend, long blued barrel over the tube magazine
        g.beginPath(); g.moveTo(-14, -6.5); g.lineTo(-34, -3.5); g.quadraticCurveTo(-36, 1, -34.5, 6); g.lineTo(-30, 6.5); g.quadraticCurveTo(-21, 2, -13, 1.5); g.closePath(); fillOut(wood(-7, 7));
        g.strokeStyle = 'rgba(40,18,5,.45)'; g.lineWidth = 0.5; for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(-15, -4 + i * 1.6); g.quadraticCurveTo(-25, -3 + i * 1.8, -33, -1.5 + i * 1.9); g.stroke(); }
        rect(-34.8, -3.8, 2, 10.2, 0.6, '#1b1a19', 0.8); // recoil pad
        rect(-15, -8.5, 12, 9.5, 1.3, gunmetal(-8.5, 1)); // receiver
        rect(-12, -5.5, 5, 2.4, 0.4, '#0c0d10', 0.5);
        g.beginPath(); g.moveTo(-9, 1); g.quadraticCurveTo(-8, 5.5, -3.5, 5); g.strokeStyle = INK; g.lineWidth = 1.6; g.stroke();
        rect(-3, -8, 36, 3.4, 0.8, steel(-8, -4.6)); // barrel
        rect(-3, -4.6, 29, 3.2, 0.8, lin(0, -4.6, 0, -1.4, ['#8b9199', '#3f444b'])); // magazine tube
        rect(3, -5.5, 14, 6.5, 2, wood(-5.5, 1)); // pump
        for (let i = 0; i < 5; i++) line(4.5 + i * 2.6, -4.6, 4.5 + i * 2.6, 0, 'rgba(40,18,5,.6)', 0.7);
        rect(31.6, -9.6, 1.4, 1.8, 0.4, '#e8d36a', 0.5); // bead sight
        line(-2, -7.4, 32, -7.4, 'rgba(255,255,255,.8)', 0.6);
        break;
      }
      case 4: { // electro gun: a tesla coil on a grip, crackling between two prongs
        glow(20, -3, 16, 'rgba(120,200,255,.55)');
        poly([[-10, 0], [-3, 0], [-1, 12], [-8, 12.5]]); fillOut(lin(-10, 0, -1, 0, ['#2b3140', '#141821']));
        rect(-20, -9, 26, 10, 3, lin(0, -9, 0, 1, ['#5d78b5', '#2b417a', '#141f40'])); // body
        rect(-18, -7.4, 6, 6.8, 1.2, rad(-15, -4, 0, 5, ['#d6f4ff', '#3fb7ff', '#0d3d7a']), 0.8); // power cell
        for (let i = 0; i < 6; i++) { rect(4 + i * 2.4, -8.4, 1.8, 8.8, 0.8, lin(0, -8.4, 0, 0.4, ['#f6c27a', '#b8702c', '#6e3b10']), 0.5); } // copper coil
        rect(3, -5.4, 16, 2.8, 1, '#262c36', 0.7);
        g.beginPath(); g.moveTo(18, -6); g.lineTo(25, -10); g.moveTo(18, -2); g.lineTo(25, 2); g.strokeStyle = INK; g.lineWidth = 2.6; g.stroke(); g.strokeStyle = '#b9c3d0'; g.lineWidth = 1.2; g.stroke();
        g.strokeStyle = 'rgba(200,240,255,.95)'; g.lineWidth = 1.1; g.beginPath(); g.moveTo(25, -10); g.lineTo(23, -6.5); g.lineTo(27, -4.5); g.lineTo(23.5, -1.5); g.lineTo(25, 2); g.stroke();
        g.strokeStyle = 'rgba(120,200,255,.8)'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(25, -10); g.lineTo(29, -7); g.lineTo(27, -3); g.lineTo(31, 0); g.stroke();
        line(-18, -8, 2, -8, 'rgba(255,255,255,.4)', 0.7);
        break;
      }
      case 5: { // flamethrower: fuel tank, hose, wand with the pilot light lit
        g.beginPath(); g.moveTo(-20, 6); g.bezierCurveTo(-18, 16, -4, 14, -4, 4); g.strokeStyle = INK; g.lineWidth = 3.4; g.stroke(); g.strokeStyle = '#3a3a3a'; g.lineWidth = 2; g.stroke();
        rect(-31, -11, 13, 23, 5.5, lin(-31, 0, -18, 0, ['#7d1608', '#d2391c', '#ff8a5c', '#a3220d', '#5c0d04'])); // tank
        rect(-28, -13.5, 7, 3, 1, steel(-13.5, -10.5), 0.8);
        line(-28.5, -6, -20.5, -6, 'rgba(0,0,0,.35)', 0.7); line(-28.5, 6, -20.5, 6, 'rgba(0,0,0,.35)', 0.7);
        rect(-12, -6, 25, 6.5, 1.5, gunmetal(-6, 0.5)); // wand
        poly([[-8, 0], [-3, 0], [-2, 9], [-7, 9.5]]); fillOut('#26282c');
        rect(2, -2.5, 6, 6, 1, '#2f3237', 0.8); // igniter
        rect(13, -7, 6, 8.5, 1, steel(-7, 1.5)); // nozzle
        flame(19.5, -2.8, 18, 9);
        break;
      }
      case 6: { // rocket launcher: olive tube with a sight and grips, the warhead poking out
        g.save(); g.beginPath(); g.moveTo(21, -2.5); g.lineTo(32, -2.5); g.lineTo(35, -0.5); g.lineTo(32, 1.5); g.lineTo(21, 1.5); g.closePath(); fillOut(lin(0, -2.5, 0, 1.5, ['#ff8a7a', '#c62a1d', '#7c120b'])); g.restore();
        rect(-27, -7, 50, 11, 4.5, lin(0, -7, 0, 4, ['#a8b37c', '#6b7a3d', '#3f4a21', '#2a3214']));
        rect(-29, -8, 5, 13, 1.5, '#2c2f22'); rect(19, -8, 5, 13, 1.5, '#2c2f22'); // end caps
        line(-22, -5, 17, -5, 'rgba(255,255,255,.35)', 0.8);
        g.fillStyle = 'rgba(30,30,20,.7)'; g.font = 'bold 3.4px sans-serif'; g.fillText('HE 84', -12, 1.6);
        rect(-6, -12.5, 9, 5.5, 1, gunmetal(-12.5, -7)); rect(3, -11.6, 2, 2.6, 0.5, '#9fe6ff', 0.6); // sight
        poly([[-4, 4], [1, 4], [2, 13], [-3, 13.5]]); fillOut('#25281e'); // grip
        poly([[-17, 4], [-13, 4], [-12, 10], [-16.5, 10.5]]); fillOut('#25281e');
        g.beginPath(); g.moveTo(1, 4.5); g.quadraticCurveTo(2, 8, 6, 7.5); g.strokeStyle = INK; g.lineWidth = 1.4; g.stroke();
        break;
      }
      case 7: { // frag grenade: segmented olive body, spoon and pin ring
        g.translate(0, 3);
        g.beginPath(); g.ellipse(0, 2, 10.5, 12.5, 0, 0, 7); fillOut(rad(-4, -3, 1, 15, ['#a7b878', '#5d6e2e', '#2f3a14']), 1.5);
        g.save(); g.beginPath(); g.ellipse(0, 2, 10.5, 12.5, 0, 0, 7); g.clip();
        g.strokeStyle = 'rgba(15,20,5,.55)'; g.lineWidth = 0.9;
        for (let yy = -8; yy <= 12; yy += 4) { g.beginPath(); g.moveTo(-12, yy); g.lineTo(12, yy); g.stroke(); }
        for (let xx = -6; xx <= 6; xx += 4) { g.beginPath(); g.moveTo(xx, -12); g.quadraticCurveTo(xx * 1.5, 2, xx, 16); g.stroke(); }
        g.restore();
        g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(-4, -4, 2.6, 4, -0.4, 0, 7); g.fill();
        rect(-4.5, -14.5, 9, 5.5, 1, steel(-14.5, -9));
        g.beginPath(); g.moveTo(3, -13); g.quadraticCurveTo(10, -14, 10, -6); g.lineTo(11.5, 4); g.strokeStyle = INK; g.lineWidth = 2.8; g.stroke(); g.strokeStyle = '#c3c8ce'; g.lineWidth = 1.4; g.stroke(); // spoon
        g.beginPath(); g.arc(-7, -15, 4, 0, 7); g.strokeStyle = INK; g.lineWidth = 2.4; g.stroke(); g.strokeStyle = '#e1c25a'; g.lineWidth = 1.1; g.stroke(); // pin ring
        break;
      }
      case 8: { // molotov: green glass bottle, a rag in the neck, burning
        g.translate(0, 4);
        g.beginPath(); g.moveTo(-3, -12); g.lineTo(-3, -6); g.quadraticCurveTo(-9, -3, -9, 3); g.lineTo(-9, 13); g.quadraticCurveTo(-9, 15, -7, 15); g.lineTo(7, 15); g.quadraticCurveTo(9, 15, 9, 13); g.lineTo(9, 3); g.quadraticCurveTo(9, -3, 3, -6); g.lineTo(3, -12); g.closePath();
        fillOut(lin(-9, 0, 9, 0, ['#1f4d18', '#4f9a3c', '#87d16c', '#3c7a2c', '#173c12']), 1.4);
        g.save(); g.clip(); g.fillStyle = lin(0, 4, 0, 15, ['rgba(214,140,40,.55)', 'rgba(150,80,20,.75)']); g.fillRect(-10, 5, 20, 11); g.restore(); // the petrol
        g.fillStyle = 'rgba(255,255,255,.45)'; g.fillRect(-6.5, 0, 1.6, 11);
        rect(-5.5, 1, 11, 6, 0.6, '#e9dfc4', 0.7); line(-3.5, 3, 3.5, 3, '#b33', 0.8); line(-3.5, 5, 2, 5, '#777', 0.6); // label
        g.beginPath(); g.moveTo(-3, -12); g.quadraticCurveTo(-6, -15, -4, -19); g.lineTo(2, -17); g.quadraticCurveTo(4, -14, 3, -12); g.closePath(); fillOut('#d8cfb4', 1); // rag
        g.save(); g.rotate(-Math.PI / 2); flame(17, -0.5, 13, 9); g.restore();
        break;
      }
      case 20: { // health: a first-aid kit
        rect(-14, -9, 28, 21, 3, lin(0, -9, 0, 12, ['#ffffff', '#e4e6ea', '#b9bdc4']), 1.5);
        rect(-5, -14, 10, 6, 2, '#9aa0a8', 1.2); rect(-3, -12.5, 6, 3.5, 1, '#3a3f45', 0.6);
        g.fillStyle = lin(0, -4, 0, 10, ['#ff5a5a', '#d71e26', '#9b0d14']); g.fillRect(-2.6, -4.4, 5.2, 13.8); g.fillRect(-7.6, 0, 15.2, 5.2);
        line(-13, -7.6, 13, -7.6, 'rgba(255,255,255,.9)', 1);
        break;
      }
      case 21: { // armour: a ballistic vest
        g.beginPath(); g.moveTo(-6, -13); g.quadraticCurveTo(0, -8, 6, -13); g.lineTo(12, -11); g.lineTo(13, 10); g.quadraticCurveTo(0, 15, -13, 10); g.lineTo(-12, -11); g.closePath();
        fillOut(lin(-13, 0, 13, 0, ['#26314a', '#4a6aa8', '#6f93d8', '#3c5994', '#1d2740']), 1.5);
        rect(-8, -4, 16, 11, 2, lin(0, -4, 0, 7, ['#9db8ee', '#5b7cc4', '#334d8f']), 1); // plate
        line(-11, -2, -8.5, -2, '#ccc', 1.2); line(8.5, -2, 11, -2, '#ccc', 1.2); line(-11, 3, -8.5, 3, '#ccc', 1.2); line(8.5, 3, 11, 3, '#ccc', 1.2);
        g.fillStyle = '#e8edf6'; g.font = 'bold 4px sans-serif'; g.textAlign = 'center'; g.fillText('ARMOR', 0, 3);
        break;
      }
      case 22: { // double damage: red x2 with a hot glow
        glow(0, 0, 18, 'rgba(255,60,40,.6)');
        g.font = 'bold 22px Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 3; g.strokeStyle = INK; g.strokeText('x2', 0, 1);
        g.fillStyle = lin(0, -9, 0, 10, ['#ffe08a', '#ff5a2a', '#b3120a']); g.fillText('x2', 0, 1);
        break;
      }
      case 23: { // invisibility: a pale ghost, half see-through
        glow(0, 0, 18, 'rgba(150,220,255,.35)');
        g.beginPath(); g.arc(0, -2, 10, Math.PI, 0); g.lineTo(10, 11); g.quadraticCurveTo(7.5, 7, 5, 11); g.quadraticCurveTo(2.5, 7, 0, 11); g.quadraticCurveTo(-2.5, 7, -5, 11); g.quadraticCurveTo(-7.5, 7, -10, 11); g.closePath();
        g.globalAlpha = 0.85; fillOut(lin(0, -12, 0, 11, ['#ffffff', '#cdeeff', 'rgba(150,210,255,.6)']), 1.2); g.globalAlpha = 1;
        g.fillStyle = '#1a2a3a'; g.beginPath(); g.ellipse(-3.6, -3, 1.8, 2.6, 0, 0, 7); g.ellipse(3.6, -3, 1.8, 2.6, 0, 0, 7); g.fill();
        g.beginPath(); g.ellipse(0, 3, 2, 1.6, 0, 0, 7); g.fill();
        break;
      }
      case 'fist': { // a clenched fist
        const skin = lin(0, -12, 0, 12, ['#f2c9a0', '#d79e6d', '#a86d42']);
        rect(-9, -2, 18, 14, 4, skin, 1.5); // back of the hand
        for (let i = 0; i < 4; i++) rect(-11 + i * 5.4, -11, 5.8, 10, 2.6, skin, 1.2); // knuckles
        g.beginPath(); g.moveTo(-12, 0); g.quadraticCurveTo(-13, 6, -6, 6); g.lineTo(4, 5); g.strokeStyle = INK; g.lineWidth = 1.3; g.stroke(); // thumb
        g.fillStyle = 'rgba(255,255,255,.35)'; for (let i = 0; i < 4; i++) g.fillRect(-9.8 + i * 5.4, -9.6, 2, 1.4);
        rect(-9, 12, 18, 4, 1, '#2f3c63', 1.2); // sleeve cuff
        break;
      }
      case 30: { // vehicle machine gun: twin barrels on a mount
        rect(-24, -8, 14, 16, 2.5, gunmetal(-8, 8)); // breech box
        for (let i = 0; i < 3; i++) line(-21, -4 + i * 4, -13, -4 + i * 4, 'rgba(255,255,255,.18)', 0.7);
        for (const y0 of [-7.5, 3.5]) {
          rect(-11, y0, 10, 4, 1, gunmetal(y0, y0 + 4));
          rect(-1, y0 + 0.6, 26, 2.8, 0.8, steel(y0 + 0.6, y0 + 3.4));
          for (let i = 0; i < 4; i++) rect(1 + i * 4, y0 + 0.2, 1.4, 3.6, 0.4, '#2a2e33', 0.4);
          rect(24.5, y0, 3.5, 4, 0.6, '#1c1f23', 0.7);
        }
        rect(-20, 8, 6, 6, 1, '#2a2d31'); // mount
        rect(-28, -3, 4, 6, 1, '#d8a21f', 0.8); // ammo feed
        break;
      }
      case 31: { // oil slick: a black drop with a rainbow sheen
        g.beginPath(); g.moveTo(0, -15); g.bezierCurveTo(5, -6, 12, -1, 12, 5); g.bezierCurveTo(12, 12, 6, 15, 0, 15); g.bezierCurveTo(-6, 15, -12, 12, -12, 5); g.bezierCurveTo(-12, -1, -5, -6, 0, -15); g.closePath();
        fillOut(rad(-3, 2, 1, 15, ['#3b3f4a', '#111216', '#000']), 1.4);
        g.save(); g.clip(); g.globalCompositeOperation = 'lighter';
        g.fillStyle = lin(-10, 0, 10, 0, ['rgba(255,60,200,.35)', 'rgba(60,200,255,.35)', 'rgba(255,230,60,.3)']); g.beginPath(); g.ellipse(-2, 6, 8, 3, -0.4, 0, 7); g.fill();
        g.restore();
        g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.ellipse(-5, 0, 1.6, 3.5, 0.4, 0, 7); g.fill();
        break;
      }
      case 32: { // car mine: a squat steel disc with a red sensor
        g.translate(0, 3);
        g.beginPath(); g.ellipse(0, 3, 16, 7, 0, 0, 7); fillOut('#1d2023', 1.4);
        g.beginPath(); g.ellipse(0, 0, 16, 7, 0, 0, 7); fillOut(lin(0, -7, 0, 7, ['#8d949c', '#4d535a', '#2a2e33']), 1.4);
        g.beginPath(); g.ellipse(0, -1, 10, 4.2, 0, 0, 7); fillOut(lin(0, -5, 0, 3, ['#6a7179', '#353a40']), 0.9);
        for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.fillStyle = '#bfc5cc'; g.beginPath(); g.arc(Math.cos(a) * 13, Math.sin(a) * 5.6, 0.8, 0, 7); g.fill(); }
        glow(0, -2.5, 8, 'rgba(255,40,30,.8)');
        g.beginPath(); g.ellipse(0, -2.5, 3, 1.8, 0, 0, 7); fillOut('#ff3020', 0.8);
        break;
      }
      case 33: { // car jump: a little car leaping, with a rising arrow
        g.save(); g.translate(0, 6); g.rotate(-0.22);
        rect(-15, -2, 30, 9, 3, lin(0, -2, 0, 7, ['#ff7a5c', '#d8432b', '#8e2414']), 1.3);
        g.beginPath(); g.moveTo(-8, -2); g.lineTo(-5, -8); g.lineTo(6, -8); g.lineTo(9, -2); g.closePath(); fillOut(lin(0, -8, 0, -2, ['#d8eefc', '#7fb3d8']), 1.1);
        for (const wx of [-9, 9]) { g.beginPath(); g.arc(wx, 7, 3.6, 0, 7); fillOut('#1b1c1e', 1); g.fillStyle = '#9aa0a8'; g.beginPath(); g.arc(wx, 7, 1.4, 0, 7); g.fill(); }
        g.restore();
        g.fillStyle = 'rgba(255,255,255,.55)'; for (let i = 0; i < 3; i++) g.fillRect(-26 + i * 3, 9 + i * 2, 6, 1.2);
        poly([[0, -27], [11, -16], [4.5, -16], [4.5, -10], [-4.5, -10], [-4.5, -16], [-11, -16]]); fillOut(lin(0, -27, 0, -10, ['#fff3a0', '#ffd21f', '#d89a0a']), 1.3);
        break;
      }
      case 34: { // helicopter missile
        g.rotate(-0.55);
        rect(-17, -3.5, 30, 7, 3.5, lin(0, -3.5, 0, 3.5, ['#ffffff', '#cfd3d8', '#7d838b']), 1.2);
        g.beginPath(); g.moveTo(12, -3.5); g.quadraticCurveTo(21, -2, 22, 0); g.quadraticCurveTo(21, 2, 12, 3.5); g.closePath(); fillOut(lin(0, -3.5, 0, 3.5, ['#ff8a7a', '#c62a1d', '#7c120b']), 1.2);
        for (const s of [-1, 1]) { poly([[-16, s * 3], [-11, s * 3], [-17, s * 9], [-20, s * 9]]); fillOut('#6b7178', 1); }
        line(-3, -3.5, -3, 3.5, '#d8a21f', 1.2);
        g.save(); g.translate(-18, 0); g.rotate(Math.PI); flame(0, 0, 14, 6); g.restore(); // exhaust
        break;
      }
    }
  }

  // ================================================================ HUD
  function txt(s, x, y, size, col, align = 'left', stroke) {
    ctx.font = `${size}px Impact, 'Arial Black', sans-serif`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke ? stroke * DPR : Math.max(2, size / 7);
    ctx.strokeStyle = '#000'; ctx.strokeText(s, x, y);
    ctx.fillStyle = col; ctx.fillText(s, x, y);
  }
  function heart(x, y, s, fill) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.beginPath(); ctx.moveTo(0, 4); ctx.bezierCurveTo(-9, -3, -5, -10, 0, -5); ctx.bezierCurveTo(5, -10, 9, -3, 0, 4); ctx.closePath();
    ctx.fillStyle = '#000'; ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.fillStyle = '#3a1111'; ctx.fill();
    if (fill > 0) { ctx.save(); ctx.clip(); ctx.fillStyle = '#e3262c'; ctx.fillRect(-10, -11, 20 * fill, 16); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(-6, -7, 3, 3); ctx.restore(); }
    ctx.restore();
  }
  function drawHUD(dt) {
    const u = clamp(Math.min(W, H * 1.6) / 1100, 0.6, 2.2);
    const pad = 18 * u;
    if (!me) return;
    // score (top-left)
    const before = Math.round(hud.score);
    hud.score = Math.abs(me.sc - hud.score) < 1 ? me.sc : damp(hud.score, me.sc, 5, dt);
    if (Math.round(hud.score) > before) hud.pulse = 1;
    hud.pulse = damp(hud.pulse, 0, 8, dt);
    {
      const sc = 1 + 0.12 * hud.pulse;
      ctx.save(); ctx.translate(pad, pad + 22 * u); ctx.scale(sc, sc);
      txt(String(Math.round(hud.score)).padStart(7, '0'), 0, 0, 42 * u, '#ffd21f');
      ctx.restore();
    }
    txt(`FRAGS ${me.fr} / ${game.fl}`, pad, pad + 58 * u, 20 * u, '#fff');
    // position
    const ranked = [...scores.values()].filter((r) => roster.has(r[0])).sort((a, b) => b[1] - a[1]);
    const pos = ranked.findIndex((r) => r[0] === myId) + 1;
    if (pos) txt(`${pos}${['', 'ST', 'ND', 'RD'][pos] || 'TH'} OF ${ranked.length}`, pad, pad + 84 * u, 16 * u, '#bbb');
    // dragged out of your car by a cop: run, or take the car back and fight for it
    if (me.al && me.cu > 0) {
      const k = (performance.now() / 1000 * 4) % 1;
      txt('RUN!  ' + me.cu.toFixed(1), W / 2, H * 0.3, (54 + (k < 0.5 ? 6 : 0)) * u, '#ff9b2b', 'center', 6);
      txt('...or get back in your car and fight the cop for it', W / 2, H * 0.3 + 44 * u, 18 * u, '#fff', 'center', 3);
    }
    // wanted level: police stars under the timer; they fade as the police lose track of you
    if (me.wl) {
      const n = me.wl, wi = (me.wi || 0) / 100, searching = wi < 0.999;
      const blink = searching ? 0.55 + 0.45 * Math.sin(performance.now() / 160) : 1;
      for (let i = 0; i < 4; i++) {
        const sx = W / 2 + (i - 1.5) * 30 * u, sy = pad + 48 * u, on = i < n;
        ctx.save(); ctx.translate(sx, sy); ctx.scale(u, u);
        ctx.beginPath();
        for (let j = 0; j < 10; j++) { const r = j % 2 ? 5 : 12, a = -Math.PI / 2 + (j * Math.PI) / 5; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
        ctx.closePath();
        ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.stroke();
        ctx.globalAlpha = on ? blink : 0.35; ctx.fillStyle = on ? (Math.floor(performance.now() / 250) % 2 ? '#4f8dff' : '#ff4040') : '#333'; ctx.fill();
        ctx.restore();
      }
      if (searching) {
        const bw = 120 * u, bx = W / 2 - bw / 2, by = pad + 66 * u;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(bx, by, bw, 6 * u);
        ctx.fillStyle = '#4f8dff'; ctx.fillRect(bx, by, bw * wi, 6 * u);
        txt('LOSING THE POLICE', W / 2, by + 16 * u, 12 * u, '#9fc2ff', 'center');
      }
    }
    // timer
    const tl = game.tl, mm = Math.floor(tl / 60), ss = String(tl % 60).padStart(2, '0');
    txt(game.st === 'over' ? `NEXT MATCH ${tl}` : `${mm}:${ss}`, W / 2, pad + 16 * u, 26 * u, game.st === 'over' ? '#ffd21f' : '#fff', 'center');
    // weapon (top-right)
    const rx = W - pad;
    let wk = null, ammo = 0, wname = '';
    if (me.al) {
      const vt = me.car ? me.car[7] : -1;
      if (vt === S.TANK && !me.cw) { wk = 6; ammo = '∞'; wname = 'TANK CANNON'; }
      else if (vt === S.FIRE && !me.cw) { wk = 'water'; ammo = ''; wname = 'WATER CANNON'; }
      else if (me.car && me.cw) { wk = 30 + me.cw[0]; ammo = vt === S.BOAT && me.cw[0] === 0 ? '∞' : me.cw[1]; wname = vt === S.BOAT && me.cw[0] === 0 ? 'MINIGUN' : S.CARWEAPONS[me.cw[0]].name; }
      else if (me.inv[me.w] > 0) { wk = me.w; ammo = me.inv[me.w]; wname = S.WEAPONS[me.w].name; }
      else { wk = 'fist'; ammo = ''; wname = 'FISTS'; }
    }
    if (wk !== hud.wk) { hud.wk = wk; hud.wt = 0; }
    hud.wt += dt;
    if (wk !== null) {
      // the weapon card: a rounded pane of dark glass with a yellow edge; the gun slides in on a swap, the ammo
      // count turns red when it's running out, and the name sits small along the bottom
      const k = clamp(hud.wt / 0.32, 0, 1), slide = (1 - E.outBack(k)) * 70 * u, pop = 1 + 0.06 * (1 - E.outCubic(clamp(hud.wt / 0.25, 0, 1)));
      const cw = 168 * u, ch = 76 * u, cx = rx - cw, cy = pad, R0 = 14 * u;
      const low = typeof ammo === 'number' && ammo > 0 && ammo <= Math.max(3, (S.WEAPONS[wk] && S.WEAPONS[wk].pick ? S.WEAPONS[wk].pick : 30) * 0.2);
      ctx.save();
      ctx.translate(cx + cw / 2, cy + ch / 2); ctx.scale(pop, pop); ctx.translate(-(cx + cw / 2), -(cy + ch / 2));
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 18 * u; ctx.shadowOffsetY = 4 * u;
      const bg = ctx.createLinearGradient(0, cy, 0, cy + ch); bg.addColorStop(0, 'rgba(22,18,30,.82)'); bg.addColorStop(1, 'rgba(12,10,18,.66)');
      rr(ctx, cx, cy, cw, ch, R0); ctx.fillStyle = bg; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 1.2 * u; ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.stroke();
      // a soft highlight along the top edge, and the accent bar down the left
      ctx.save(); rr(ctx, cx, cy, cw, ch, R0); ctx.clip();
      const hl = ctx.createLinearGradient(0, cy, 0, cy + ch * 0.5); hl.addColorStop(0, 'rgba(255,255,255,.09)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl; ctx.fillRect(cx, cy, cw, ch * 0.5);
      ctx.fillStyle = low ? '#ff4b3e' : '#ffd21f'; ctx.fillRect(cx, cy, 4 * u, ch);
      ctx.restore();
      ctx.globalAlpha = Math.min(1, k * 2.5);
      ctx.save(); ctx.beginPath(); ctx.rect(cx + 4 * u, cy, cw - 4 * u, ch); ctx.clip();
      icon(ctx, wk, cx + 52 * u + slide, cy + 31 * u, 1.2 * u);
      ctx.restore();
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'right';
      ctx.font = `${32 * u}px Anton, Impact, 'Arial Black', sans-serif`;
      const blink = low && (performance.now() / 300) % 2 < 1;
      ctx.fillStyle = low ? (blink ? '#ff6b5e' : '#ff3b30') : '#fff';
      ctx.fillText(String(ammo), rx - 14 * u + slide * 0.4, cy + 44 * u);
      ctx.font = `800 ${10.5 * u}px system-ui, sans-serif`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${1.6 * u}px`;
      ctx.fillStyle = 'rgba(255,214,60,.95)'; ctx.fillText(wname, rx - 14 * u, cy + ch - 11 * u);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    // driving: the gun you'll have in your hand when you get out (Z/X changes it)
    if (me.al && me.car) {
      const fw = me.inv[me.w] > 0 ? S.WEAPONS[me.w].name + ' ' + me.inv[me.w] : 'FISTS';
      if (me.cw) txt('ON FOOT: ' + fw, rx - 176 * u, pad + 30 * u, 13 * u, '#ddd', 'right');
    }
    // health & armour
    if (me.al) {
      const hp = me.hp || 0;
      const jit = hud.hurt > 0.15 ? hud.hurt * 3 * u : 0;
      // five hearts, plus extra ones from health boosts (every 100 pedestrian points)
      const nh = Math.max(5, Math.min(8, Math.ceil(hp / 20)));
      for (let i = 0; i < nh; i++) heart(rx - 14 * u - (nh - 1 - i) * 26 * u + rnd(-jit, jit), pad + 104 * u + rnd(-jit, jit), 1.35 * u * (1 + 0.15 * hud.hurt), clamp((hp - i * 20) / 20, 0, 1));
      if (me.ar > 0) {
        ctx.save(); ctx.translate(rx - 150 * u, pad + 104 * u); ctx.scale(u, u);
        icon(ctx, 21, 0, 0, 0.9); ctx.restore();
        txt(String(me.ar), rx - 132 * u, pad + 104 * u, 16 * u, '#9cc4ff');
      }
      let iy = pad + 136 * u;
      if (me.car && me.car[8]) {
        const ups = S.UP_NAMES.filter(([b]) => me.car[8] & b).map(([, n]) => n);
        if (ups.length) { txt(ups.join(' · '), rx, iy, 15 * u, '#ff9c2b', 'right'); iy += 22 * u; }
      }
      if (me.q) { txt(`DOUBLE DAMAGE ${me.q}`, rx, iy, 16 * u, '#ff4b4b', 'right'); iy += 22 * u; }
      if (me.iv) { txt(`INVISIBLE ${me.iv}`, rx, iy, 16 * u, '#9fd8ff', 'right'); iy += 22 * u; }
      if (me.cr) { txt('CREW ' + '●'.repeat(Math.min(3, me.cr)) + '○'.repeat(Math.max(0, 3 - me.cr)), rx, iy, 16 * u, '#5fd16a', 'right'); iy += 22 * u; }
      // a hint the first time you're driving slowly past gang members
      const sN = snaps.length ? snaps[snaps.length - 1].N : null;
      if (!crewHintDone && me.car && sN && Math.hypot(me.car[3], me.car[4]) < 90) {
        if (sN.some((r) => r[4] & 8 && !r[6] && Math.hypot(r[1] - me.car[0], r[2] - me.car[1]) < 170)) { lowMsg = { txt: 'GANG MEMBERS: HONK (H) TO PICK THEM UP', t: 3 }; crewHintDone = true; }
      }
    }
    // kill feed & chat (bottom-left)
    let fy = H - pad - 10 * u;
    for (let i = feed.length - 1; i >= 0; i--) {
      const f = feed[i]; f.t -= dt;
      if (f.t <= 0) { feed.splice(i, 1); continue; }
      ctx.globalAlpha = clamp(f.t, 0, 1);
      txt(f.txt, pad, fy, 16 * u, f.vid === myId || f.kid === myId ? '#ffd21f' : '#fff');
      fy -= 22 * u;
    }
    ctx.globalAlpha = 1;
    fy -= 8 * u;
    for (let i = chat.length - 1; i >= 0; i--) {
      const c = chat[i]; c.t -= dt;
      if (c.t <= 0) { chat.splice(i, 1); continue; }
      ctx.globalAlpha = clamp(c.t, 0, 1);
      ctx.font = `${15 * u}px system-ui, sans-serif`;
      const who = c.id ? nm(c.id) + ': ' : '';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3 * u; ctx.strokeStyle = '#000';
      ctx.strokeText(who + c.txt, pad, fy);
      ctx.fillStyle = c.id ? nc(c.id) : '#aaa'; ctx.fillText(who, pad, fy);
      ctx.fillStyle = '#fff'; ctx.fillText(c.txt, pad + ctx.measureText(who).width, fy);
      fy -= 20 * u;
    }
    ctx.globalAlpha = 1;
    drawRaceHud(dt, u, pad);
    drawBrawlHud(u, pad);
    // messages
    // messages ease in with a little overshoot and ease out
    if (bigMsg) {
      bigMsg.t -= dt; bigMsg.a = (bigMsg.a || 0) + dt;
      const k = clamp(bigMsg.a / 0.5, 0, 1), sc = lerp(2.1, 1, E.outBack(k));
      ctx.globalAlpha = Math.min(1, bigMsg.a * 5) * clamp(bigMsg.t * 2, 0, 1);
      txt(bigMsg.txt, W / 2, H * 0.38 - (1 - clamp(bigMsg.t * 2, 0, 1)) * 30 * u, 92 * u * sc, bigMsg.col, 'center', 6 * u / DPR);
      ctx.globalAlpha = 1;
      if (bigMsg.t <= 0) bigMsg = null;
    }
    if (midMsg) {
      midMsg.t -= dt; midMsg.a = (midMsg.a || 0) + dt;
      const k = E.outBack(clamp(midMsg.a / 0.35, 0, 1));
      ctx.globalAlpha = clamp(midMsg.t * 2.5, 0, 1) * Math.min(1, midMsg.a * 6);
      txt(midMsg.txt, W / 2, H * 0.28 - (1 - k) * 50 * u, 40 * u * (0.7 + 0.3 * k), midMsg.col, 'center');
      ctx.globalAlpha = 1;
      if (midMsg.t <= 0) midMsg = null;
    }
    if (lowMsg) {
      lowMsg.t -= dt; lowMsg.a = (lowMsg.a || 0) + dt;
      const k = E.outCubic(clamp(lowMsg.a / 0.3, 0, 1));
      ctx.globalAlpha = clamp(lowMsg.t * 2, 0, 1) * k;
      txt(lowMsg.txt, W / 2, H - 70 * u + (1 - k) * 24 * u, 30 * u, '#fff', 'center');
      ctx.globalAlpha = 1;
      if (lowMsg.t <= 0) lowMsg = null;
    }
    if (radioMsg) {
      radioMsg.t -= dt; radioMsg.a = (radioMsg.a || 0) + dt;
      const k = E.outCubic(clamp(radioMsg.a / 0.35, 0, 1));
      ctx.globalAlpha = clamp(radioMsg.t * 2, 0, 1) * k;
      txt(radioMsg.txt, W / 2 + (1 - k) * 40 * u, H - 34 * u, 20 * u, '#9fd8ff', 'center');
      ctx.globalAlpha = 1;
      if (radioMsg.t <= 0) radioMsg = null;
    }
    if (!me.al && game.st === 'play') txt(`RESPAWN IN ${me.rs}`, W / 2, H * 0.5, 26 * u, '#fff', 'center');
    if (pred.mode === 'ped' && performance.now() / 1000 % 1 < 2 && me.inv && me.inv.every((a) => !a)) txt('OUT OF AMMO: FISTS ONLY - FIND A CRATE', W / 2, H - 110 * u, 18 * u, '#ff9b9b', 'center');
    txt(`${Math.round(ping)} ms`, W - pad, H - pad, 12 * u, '#888', 'right');
    if (Audio.muted) txt('MUTED', W - pad, H - pad - 18 * u, 12 * u, '#888', 'right');
    if (game.st === 'over' && !menuOpen) drawScores(u);
  }
  function drawScores(u) {
    const rows = [...roster.entries()].map(([id, r]) => ({ id, ...r, s: scores.get(id) || [id, 0, 0, 0, 0] })).sort((a, b) => b.s[1] - a.s[1] || b.s[3] - a.s[3]);
    const w = 520 * u, rh = 30 * u, h = (rows.length + 2) * rh + 20 * u, x = (W - w) / 2, y = H * 0.45 - h / 2 + 60 * u;
    ctx.fillStyle = 'rgba(0,0,0,.78)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = 2 * u; ctx.strokeRect(x, y, w, h);
    txt('PLAYER', x + 20 * u, y + rh, 18 * u, '#ffd21f');
    txt('FRAGS', x + w * 0.62, y + rh, 18 * u, '#ffd21f', 'center');
    txt('DEATHS', x + w * 0.76, y + rh, 18 * u, '#ffd21f', 'center');
    txt('PING', x + w * 0.9, y + rh, 18 * u, '#ffd21f', 'center');
    rows.forEach((r, i) => {
      const yy = y + (i + 2) * rh + 6 * u;
      if (r.id === myId) { ctx.fillStyle = 'rgba(255,210,31,.15)'; ctx.fillRect(x + 6 * u, yy - rh / 2, w - 12 * u, rh); }
      ctx.fillStyle = r.color; ctx.fillRect(x + 20 * u, yy - 7 * u, 14 * u, 14 * u);
      txt(r.name, x + 44 * u, yy, 18 * u, '#fff');
      txt(String(r.s[1]), x + w * 0.62, yy, 18 * u, '#fff', 'center');
      txt(String(r.s[2]), x + w * 0.76, yy, 18 * u, '#fff', 'center');
      txt(r.bot ? 'BOT' : String(r.s[4]), x + w * 0.9, yy, 16 * u, '#999', 'center');
    });
  }

  // ================================================================ audio
  // Everything is synthesised in the page (an artifact can't load outside audio), layered for realism:
  // a short transient, a body, a low thump, and a city-street reverb tail. Sounds are panned by position
  // and get duller and more echoey with distance. Voices are embedded clips (public/voices.js).
  const Audio = (() => {
    let ac = null, master = null, revIn = null, noise = null, brown = null;
    let eng = null, skid = null, ann = null, boat = null, tank = null;
    let lx = 0, ly = 0;
    const A = { muted: store.get('cc_mute') === '1' };
    // volume mixer (menu sliders): master, effects, voices, radio; 0..1 each, remembered in this browser
    const VOL = {};
    for (const k of ['master', 'sfx', 'voice', 'radio']) { const v = parseFloat(store.get('cc_vol_' + k)); VOL[k] = isFinite(v) ? clamp(v, 0, 1) : k === 'radio' ? 0.3 : 1; } // the radio starts at 30%
    let sfxG = null, voiceG = null, radioG = null;
    A.vol = (k) => VOL[k];
    A.setVol = (k, v) => {
      VOL[k] = clamp(v, 0, 1); store.set('cc_vol_' + k, String(VOL[k]));
      if (!ac) return;
      if (k === 'master') master.gain.value = A.muted ? 0 : 0.8 * VOL.master;
      else ({ sfx: sfxG, voice: voiceG, radio: radioG })[k].gain.value = VOL[k];
      if (k === 'radio' || k === 'master') Radio.setVolume(VOL.radio * VOL.master);
    };
    const VO = { ann: {}, people: [], cop: {} };
    function makeIR(sec) {
      const sr = ac.sampleRate, n = Math.floor(sr * sec), b = ac.createBuffer(2, n, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = b.getChannelData(ch);
        // early reflections off building walls, then a darkening diffuse tail
        for (let r = 0; r < 9; r++) { const i = Math.floor(sr * (0.012 + Math.random() * 0.09)); d[i] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - r * 0.06); }
        let lp = 0;
        for (let i = 0; i < n; i++) {
          const t = i / n, k = 0.5 + t * 0.45;
          lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
          d[i] += lp * Math.pow(1 - t, 3.2) * 1.6;
        }
      }
      return b;
    }
    function b64(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
    async function loadVoices() {
      const V = window.CC_VOICES;
      if (!V) return;
      const dec = (s) => ac.decodeAudioData(b64(s)).catch(() => null);
      for (const [k, s] of Object.entries(V.announcer)) VO.ann[k] = await dec(s);
      if (V.cop) for (const [k, list] of Object.entries(V.cop)) { VO.cop[k] = []; for (const s of list) { const b = await dec(s); if (b) VO.cop[k].push(b); } }
      for (const p of V.people) {
        const o = {};
        for (const [k, list] of Object.entries(p)) { o[k] = []; for (const s of list) { const b = await dec(s); if (b) o[k].push(b); } }
        VO.people.push(o);
      }
    }
    A.init = () => {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;
        comp.connect(ac.destination);
        master = ac.createGain(); master.gain.value = A.muted ? 0 : 0.8 * VOL.master; master.connect(comp);
        sfxG = ac.createGain(); sfxG.gain.value = VOL.sfx; sfxG.connect(master);
        voiceG = ac.createGain(); voiceG.gain.value = VOL.voice; voiceG.connect(master);
        radioG = ac.createGain(); radioG.gain.value = VOL.radio; radioG.connect(master);
        const conv = ac.createConvolver(); conv.buffer = makeIR(2.2);
        const wet = ac.createGain(); wet.gain.value = 0.3;
        revIn = ac.createGain(); revIn.connect(conv); conv.connect(wet); wet.connect(master);
        const sr = ac.sampleRate;
        noise = ac.createBuffer(1, sr * 2, sr);
        brown = ac.createBuffer(1, sr * 3, sr);
        const nd = noise.getChannelData(0), bd = brown.getChannelData(0);
        let last = 0;
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        for (let i = 0; i < bd.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = last * 3.5; }
        buildEngine(); buildTank(); buildBoat(); buildSkid(); buildGuns();
        loadVoices();
      } catch { ac = null; }
    };
    A.toggle = () => {
      A.muted = !A.muted; store.set('cc_mute', A.muted ? '1' : '0');
      if (master) master.gain.value = A.muted ? 0 : 0.8 * VOL.master;
      Radio.setMuted(A.muted);
      if (A.muted && window.speechSynthesis) speechSynthesis.cancel();
    };
    A.ctx = () => ac; A.out = () => master; A.radioOut = () => radioG || master; A.noise = () => noise;
    A.listener = (x, y) => { lx = x; ly = y; };

    // positional bus: pan, distance attenuation, distance low-pass, more reverb far away
    function bus(x, y, vol = 1, toBus) {
      let g = vol, pan = 0, lpf = 18000, send = 0.12;
      if (x !== undefined) {
        const d = Math.hypot(x - lx, y - ly);
        g = vol / (1 + Math.pow(d / 380, 1.7));
        if (g < 0.004) return null;
        pan = clamp((x - lx) / 650, -0.9, 0.9);
        lpf = clamp(17000 * Math.exp(-d / 650), 700, 17000);
        send = 0.12 + Math.min(0.55, d / 1600);
      }
      const inp = ac.createGain(); inp.gain.value = g;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpf;
      const pn = ac.createStereoPanner ? ac.createStereoPanner() : null;
      inp.connect(lp);
      const out = pn || lp;
      if (pn) { pn.pan.value = pan; lp.connect(pn); }
      out.connect(toBus || sfxG || master);
      const s = ac.createGain(); s.gain.value = send * ((toBus || sfxG) === voiceG ? VOL.voice : VOL.sfx); out.connect(s); s.connect(revIn);
      return inp;
    }
    function env(dst, t, a, d, peak) {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
      g.connect(dst); return g;
    }
    function nz(dst, t, d, type, f0, f1, peak, q = 0.8, a = 0.001, buf = noise) {
      const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
      const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + a + d);
      s.connect(f); f.connect(env(dst, t, a, d, peak));
      s.start(t, Math.random() * 1.5); s.stop(t + a + d + 0.05);
    }
    function tone(dst, t, d, type, f0, f1, peak, a = 0.002) {
      const o = ac.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + d);
      o.connect(env(dst, t, a, d, peak)); o.start(t); o.stop(t + a + d + 0.05);
    }
    function metal(dst, t, base, d, peak) {
      for (const r of [1, 2.76, 5.4, 8.93]) tone(dst, t, d * (1.2 - r / 12), 'sine', base * r * rnd(0.97, 1.03), base * r * 0.98, peak / r);
    }
    function glassy(dst, t, n, peak) {
      for (let i = 0; i < n; i++) tone(dst, t + Math.random() * 0.12, rnd(0.08, 0.35), 'sine', rnd(2800, 7500), rnd(2600, 7000), peak * rnd(0.4, 1));
      nz(dst, t, 0.1, 'highpass', 5000, 4000, peak * 2);
    }
    function crackles(dst, t, n, span, peak) {
      for (let i = 0; i < n; i++) nz(dst, t + Math.random() * span, 0.004 + Math.random() * 0.01, 'highpass', 2500, 2000, peak * Math.random());
    }

    // ---------------- gunshots: rendered sample by sample once, then played back with a little variation
    // Each shot is a supersonic crack (N-wave), a muzzle blast (noise through a closing low-pass), a low
    // boom, soft clipping, slap-back off the street walls and a city echo tail, plus the gun's own
    // mechanics (slide, bolt, pump) and now and then a spent casing tinkling on the tarmac.
    const GUN = {
      pistol: { len: 1.0, crack: 0.9, tau: 0.017, body: 1.0, f0: 7500, f1: 950, fT: 0.022, boom: 0.6, bf0: 165, bf1: 58, bT: 0.045, drive: 2.4, slap: 0.42, tail: 0.11, tailT: 0.3 },
      mg: { len: 0.7, crack: 0.85, tau: 0.012, body: 0.9, f0: 8000, f1: 1200, fT: 0.018, boom: 0.5, bf0: 150, bf1: 62, bT: 0.035, drive: 2.6, slap: 0.33, tail: 0.08, tailT: 0.22 },
      hmg: { len: 1.0, crack: 1.0, tau: 0.024, body: 1.1, f0: 5200, f1: 520, fT: 0.03, boom: 1.0, bf0: 115, bf1: 42, bT: 0.075, drive: 3.0, slap: 0.42, tail: 0.13, tailT: 0.32 },
      shotgun: { len: 1.5, crack: 1.0, tau: 0.038, body: 1.3, f0: 4600, f1: 360, fT: 0.055, boom: 1.2, bf0: 98, bf1: 36, bT: 0.11, drive: 3.2, slap: 0.48, tail: 0.17, tailT: 0.48 },
    };
    const gunBufs = {};
    function renderGun(kind, seed) {
      const P = GUN[kind], sr = ac.sampleRate, R = S.rng(seed), rn = (a, b) => a + (b - a) * R(), n = Math.floor(P.len * sr);
      const dry = new Float32Array(n), out = new Float32Array(n);
      // 1. the crack: a sharp N-shaped pressure wave, under a millisecond each way
      const nw = Math.max(2, Math.floor(sr * rn(0.00045, 0.0008)));
      for (let i = 0; i < nw * 2; i++) dry[i] += P.crack * (1 - i / nw);
      // 2. muzzle blast: noise through a resonant low-pass that closes fast (state-variable filter)
      const tau = P.tau * rn(0.85, 1.15), f0 = P.f0 * rn(0.85, 1.1);
      let lp = 0, bp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, e = Math.exp(-t / tau) * (1 - Math.exp(-t / 0.0003));
        if (t > 0.02 && e < 1e-5) break;
        const fc = Math.min(sr / 6, P.f1 + (f0 - P.f1) * Math.exp(-t / P.fT)), f = 2 * Math.sin((Math.PI * fc) / sr);
        lp += f * bp; const hp = (R() * 2 - 1) * e - lp - 0.9 * bp; bp += f * hp;
        dry[i] += P.body * (lp * 0.9 + bp * 0.45);
      }
      // 3. the boom you feel: a falling sine
      let ph = 0;
      const bT = P.bT * rn(0.85, 1.15);
      for (let i = 0; i < n; i++) {
        const t = i / sr, e = Math.exp(-t / bT) * (1 - Math.exp(-t / 0.0012));
        if (t > 0.05 && e < 1e-5) break;
        ph += (2 * Math.PI * (P.bf1 + (P.bf0 - P.bf1) * Math.exp(-t / 0.025))) / sr;
        dry[i] += P.boom * Math.sin(ph) * e;
      }
      // 4. soft clipping, the way a hot recording squashes the peak
      const td = Math.tanh(P.drive);
      for (let i = 0; i < n; i++) dry[i] = Math.tanh(P.drive * dry[i]) / td;
      for (let i = 0; i < n; i++) out[i] = dry[i];
      // 5. slap-back off nearby walls (darker each bounce) and one far building
      const taps = [[rn(0.009, 0.016), 1], [rn(0.02, 0.034), 0.7], [rn(0.04, 0.06), 0.45], [rn(0.11, 0.2), 0.35]];
      for (const [dl, g0] of taps) {
        const off = Math.floor(dl * sr), g = P.slap * g0 * rn(0.7, 1), a = 1 - Math.exp((-2 * Math.PI * rn(1400, 2600)) / sr);
        let y = 0;
        for (let i = 0; i + off < n; i++) { y += a * (dry[i] - y); out[i + off] += g * y; if (i > sr * 0.25) break; }
      }
      // 6. the city answers: a dark, rolling echo tail
      {
        let y1 = 0, y2 = 0;
        const a = 1 - Math.exp((-2 * Math.PI * 900) / sr), tT = P.tailT * rn(0.85, 1.2);
        for (let i = Math.floor(0.012 * sr); i < n; i++) {
          const t = i / sr, e = (1 - Math.exp(-(t - 0.012) / 0.03)) * Math.exp(-t / tT) * (0.75 + 0.25 * Math.sin(t * rn(18, 30)));
          y1 += a * ((R() * 2 - 1) - y1); y2 += a * (y1 - y2);
          out[i] += P.tail * 3 * y2 * e;
        }
      }
      // 7. mechanics
      const click = (t0, f, amp, len = 0.012) => {
        const s0 = Math.floor(t0 * sr), m = Math.floor(len * 4 * sr);
        const fs = [f, f * 2.31, f * 3.73].map((x) => x * rn(0.95, 1.05));
        for (let i = 0; i < m && s0 + i < n; i++) {
          const t = i / sr, e = Math.exp(-t / (len * 0.35)), en = Math.exp(-t / 0.0015);
          let v = (R() * 2 - 1) * en * 0.6;
          for (let k = 0; k < 3; k++) v += Math.sin(2 * Math.PI * fs[k] * t) * e / (k + 1.2);
          out[s0 + i] += amp * v;
        }
      };
      const slide = (t0, d, f, amp) => {
        const s0 = Math.floor(t0 * sr), m = Math.floor(d * sr);
        let l = 0, b = 0;
        const fq = 2 * Math.sin((Math.PI * f) / sr);
        for (let i = 0; i < m && s0 + i < n; i++) {
          const e = Math.sin((Math.PI * i) / m);
          l += fq * b; const h = (R() * 2 - 1) * e - l - 0.3 * b; b += fq * h;
          out[s0 + i] += amp * b * 0.3;
        }
      };
      const casing = (t0, f, amp) => {
        let tt = t0, a = amp;
        for (let k = 0; k < 4; k++) { click(tt, f * rn(0.92, 1.08), a, rn(0.025, 0.05)); tt += rn(0.05, 0.11) * (1 - k * 0.2); a *= rn(0.4, 0.65); }
      };
      if (kind === 'pistol') { const s0 = rn(0.028, 0.04); click(s0, rn(2600, 3400), 0.12); click(s0 + rn(0.01, 0.016), rn(3200, 4000), 0.1); if (R() < 0.6) casing(rn(0.38, 0.6), rn(5200, 7400), 0.05); }
      if (kind === 'mg') { click(rn(0.022, 0.03), rn(2200, 2900), 0.09); if (R() < 0.35) casing(rn(0.3, 0.5), rn(5600, 7600), 0.035); }
      if (kind === 'hmg') { click(rn(0.028, 0.036), rn(1300, 1800), 0.16, 0.02); if (R() < 0.5) casing(rn(0.3, 0.55), rn(3600, 4800), 0.06); }
      if (kind === 'shotgun') {
        const pt = rn(0.4, 0.48);
        click(pt, rn(1500, 1900), 0.35, 0.016); slide(pt + 0.005, 0.07, 1100, 0.6);
        click(pt + rn(0.12, 0.15), rn(1700, 2100), 0.42, 0.016); slide(pt + 0.08, 0.05, 1300, 0.5);
        casing(pt + rn(0.3, 0.45), rn(1600, 2300), 0.06); // plastic hull: duller
      }
      // normalise and fade the very end
      let pk = 0;
      for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
      const g = 0.95 / (pk || 1), fade = Math.floor(0.03 * sr);
      for (let i = 0; i < n; i++) out[i] *= g * (i > n - fade ? (n - i) / fade : 1);
      const b = ac.createBuffer(1, n, sr); b.getChannelData(0).set(out);
      return b;
    }
    function buildGuns() {
      let seed = (Math.random() * 1e6) | 0;
      const kinds = Object.keys(GUN);
      let i = 0;
      // spread the work over a few frames so the game never hitches
      const next = () => {
        if (!ac) return;
        const k = kinds[i >> 2];
        if (!k) return;
        (gunBufs[k] = gunBufs[k] || []).push(renderGun(k, seed++));
        i++;
        setTimeout(next, 0);
      };
      next();
    }
    function gun(kind, d, t, v) {
      const set = gunBufs[kind];
      if (!set || !set.length) return false;
      const s = ac.createBufferSource(); s.buffer = set[Math.floor(Math.random() * set.length)];
      s.playbackRate.value = rnd(0.94, 1.06);
      const g = ac.createGain(); g.gain.value = v * (kind === 'shotgun' ? 1.25 : kind === 'hmg' ? 1.15 : 1);
      s.connect(g); g.connect(d); s.start(t);
      return true;
    }
    A.gunStats = () => Object.fromEntries(Object.entries(gunBufs).map(([k, v]) => [k, v.length]));

    const SFX = {
      ding(d, t, v) { for (const [f, k] of [[1320, 1], [1980, 0.5], [2640, 0.25]]) tone(d, t, 0.5, 'sine', f, f, 0.35 * v * k); tone(d, t + 0.09, 0.45, 'sine', 1760, 1760, 0.25 * v); },
      beep(d, t, v) { tone(d, t, 0.22, 'square', 880, 880, 0.18 * v); },
      airhorn(d, t, v) { for (const f of [233, 294, 349]) tone(d, t, 0.7, 'sawtooth', f, f * 0.98, 0.16 * v, 0.02); },
      cork(d, t, v) { nz(d, t, 0.03, 'bandpass', 900, 600, 1.2 * v, 3); tone(d, t, 0.05, 'sine', 420, 160, 0.8 * v); nz(d, t + 0.04, 1.4, 'highpass', 5000, 3500, 0.25 * v, 0.7, 0.05); },
      spray(d, t, v) { // a roller door rattling down, a spray gun in short bursts, an air wrench
        crackles(d, t, 26, 0.55, 0.35 * v);
        for (let i = 0; i < 3; i++) nz(d, t + 0.6 + i * 0.32, 0.24, 'bandpass', 5600, 4800, 0.2 * v, 0.8, 0.02);
        crackles(d, t + 1.6, 14, 0.25, 0.5 * v);
      },
      fizz(d, t, v) { nz(d, t, 0.35, 'highpass', 6500, 5000, 0.12 * v, 0.7, 0.02); crackles(d, t, 10, 0.3, 0.25 * v); },
      hmg(d, t, v) { if (!gun('hmg', d, t, v)) SFX.mg(d, t, v * 1.2); },
      boing(d, t, v) { tone(d, t, 0.42, 'sine', 140, 520, 0.9 * v); tone(d, t + 0.02, 0.3, 'triangle', 280, 900, 0.25 * v); },
      pistol(d, t, v) {
        if (gun('pistol', d, t, v)) return;
        nz(d, t, 0.012, 'highpass', 3200, 2500, 1.1 * v);
        nz(d, t, 0.12, 'lowpass', 3800, 500, 0.9 * v, 0.7);
        tone(d, t, 0.08, 'sine', 190, 55, 0.8 * v);
        nz(d, t + 0.07, 0.015, 'bandpass', 4200, 4000, 0.12 * v, 4);
      },
      mg(d, t, v) {
        if (gun('mg', d, t, v)) return;
        nz(d, t, 0.008, 'highpass', 3500, 2800, 0.9 * v);
        nz(d, t, 0.075, 'lowpass', 4200, 800, 0.75 * v, 0.7);
        tone(d, t, 0.06, 'sine', 160, 60, 0.6 * v);
      },
      shotgun(d, t, v) {
        if (gun('shotgun', d, t, v)) return;
        nz(d, t, 0.02, 'highpass', 2500, 1800, 1.0 * v);
        nz(d, t, 0.3, 'lowpass', 2600, 220, 1.3 * v, 0.6);
        tone(d, t, 0.32, 'sine', 100, 34, 1.0 * v);
        nz(d, t + 0.38, 0.03, 'bandpass', 2400, 2000, 0.25 * v, 3);
        nz(d, t + 0.5, 0.04, 'bandpass', 1800, 1500, 0.3 * v, 3);
      },
      zap(d, t, v) {
        tone(d, t, 0.09, 'sawtooth', rnd(55, 75), 60, 0.25 * v);
        tone(d, t, 0.06, 'square', rnd(900, 2200), rnd(300, 600), 0.06 * v);
        crackles(d, t, 6, 0.08, 0.5 * v);
      },
      flame(d, t, v) {
        nz(d, t, 0.26, 'lowpass', 700, 450, 0.55 * v, 0.7, 0.03, brown);
        nz(d, t, 0.22, 'bandpass', 1100, 700, 0.18 * v, 0.6, 0.02);
        crackles(d, t, 4, 0.2, 0.25 * v);
      },
      rocket(d, t, v) {
        tone(d, t, 0.18, 'sine', 95, 40, 0.8 * v);
        nz(d, t, 0.05, 'highpass', 2000, 1500, 0.6 * v);
        nz(d, t, 0.7, 'bandpass', 700, 2600, 0.5 * v, 1.2, 0.02);
        nz(d, t + 0.05, 0.9, 'highpass', 5000, 3000, 0.18 * v, 0.7, 0.05);
      },
      throw(d, t, v) { nz(d, t, 0.2, 'bandpass', 450, 1300, 0.25 * v, 1.4, 0.05); },
      boom(d, t, v) {
        nz(d, t, 0.035, 'highpass', 1500, 900, 1.2 * v);
        tone(d, t, 1.5, 'sine', 72, 26, 1.5 * v, 0.004);
        nz(d, t, 2.4, 'lowpass', 900, 110, 2.0 * v, 0.7, 0.008, brown);
        nz(d, t, 0.6, 'bandpass', 420, 160, 0.7 * v, 0.8);
        crackles(d, t + 0.05, 26, 1.3, 0.35 * v);
        for (let i = 0; i < 4; i++) metal(d, t + rnd(0.3, 1.6), rnd(500, 1300), 0.25, 0.08 * v);
      },
      glass(d, t, v) {
        glassy(d, t, 12, 0.14 * v);
        nz(d, t + 0.08, 0.6, 'lowpass', 220, 1100, 0.7 * v, 0.7, 0.12, brown);
      },
      ignite(d, t, v) { nz(d, t, 0.7, 'lowpass', 180, 1000, 0.9 * v, 0.7, 0.15, brown); crackles(d, t + 0.1, 8, 0.6, 0.3 * v); },
      splat(d, t, v) {
        nz(d, t, 0.24, 'lowpass', 800, 140, 1.1 * v);
        tone(d, t, 0.18, 'sine', 120, 45, 0.7 * v);
        for (let i = 0; i < 3; i++) nz(d, t + 0.03 + i * 0.05, 0.05, 'bandpass', 1300, 900, 0.3 * v, 2);
      },
      punch(d, t, v) {
        nz(d, t, 0.015, 'highpass', 2600, 2200, 0.5 * v);
        nz(d, t, 0.1, 'lowpass', 1500, 180, 1.0 * v);
        tone(d, t, 0.11, 'sine', 115, 52, 0.8 * v);
      },
      whoosh(d, t, v) { nz(d, t, 0.18, 'bandpass', 380, 1700, 0.28 * v, 1.5, 0.06); },
      door(d, t, v) {
        tone(d, t, 0.012, 'square', 1900, 1700, 0.18 * v);
        nz(d, t + 0.01, 0.14, 'lowpass', 650, 110, 0.9 * v);
        tone(d, t + 0.01, 0.12, 'sine', 95, 58, 0.6 * v);
      },
      horn(d, t, v) {
        const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2; bp.connect(d);
        const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32 * v, t + 0.015);
        g.gain.setValueAtTime(0.32 * v, t + 0.42); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5); g.connect(bp);
        for (const f of [392, 494, 397]) { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 0.55); }
      },
      crash(d, t, v) {
        tone(d, t, 0.22, 'sine', 85, 38, 1.1 * v);
        nz(d, t, 0.45, 'lowpass', 3200, 200, 1.3 * v);
        nz(d, t, 0.06, 'highpass', 3000, 2500, 0.6 * v);
        metal(d, t, rnd(180, 320), 0.6, 0.35 * v);
        metal(d, t + 0.03, rnd(500, 900), 0.4, 0.2 * v);
        if (v > 0.6) glassy(d, t + 0.02, 8, 0.1 * v);
      },
      clunk(d, t, v) { metal(d, t, 300, 0.25, 0.25 * v); nz(d, t, 0.1, 'lowpass', 600, 120, 0.6 * v); },
      splash(d, t, v) {
        nz(d, t, 0.8, 'lowpass', 3200, 260, 1.1 * v, 0.7, 0.01);
        for (let i = 0; i < 9; i++) tone(d, t + rnd(0.1, 0.7), 0.06, 'sine', rnd(250, 500), rnd(700, 1300), 0.12 * v);
      },
      pickup(d, t) {
        [880, 1318.5, 1760].forEach((f, i) => { tone(d, t + i * 0.06, 0.6, 'sine', f, f, 0.14); tone(d, t + i * 0.06, 0.3, 'sine', f * 2.01, f * 2, 0.04); });
      },
      wasted(d, t) {
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.connect(d);
        tone(lp, t, 1.5, 'sawtooth', 110, 52, 0.4, 0.02); tone(lp, t, 1.5, 'sawtooth', 165, 78, 0.25, 0.02);
        tone(d, t, 1.4, 'sine', 55, 30, 0.6);
      },
      fanfare(d, t) {
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(d);
        [523, 659, 784, 1046].forEach((f, i) => { tone(lp, t + i * 0.14, 0.35, 'sawtooth', f, f, 0.12, 0.01); tone(lp, t + i * 0.14, 0.35, 'sawtooth', f * 1.005, f, 0.08, 0.01); });
      },
      jump(d, t) { nz(d, t, 0.12, 'bandpass', 700, 1100, 0.12, 1, 0.02); },
      // a short breathy "hup!" from the jumper: an "h" of breath, a voiced "u" through mouth formants, cut off by the "p"
      hup(d, t) {
        const f0 = rnd(150, 200), dur = 0.13;
        nz(d, t, 0.05, 'bandpass', 1400, 1400, 0.05, 1.2, 0.005); // h
        const o = ac.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(f0 * 1.15, t + 0.03); o.frequency.exponentialRampToValueAtTime(f0 * 0.85, t + 0.03 + dur);
        const g = ac.createGain(); g.gain.setValueAtTime(0, t + 0.03); g.gain.linearRampToValueAtTime(0.16, t + 0.05); g.gain.setValueAtTime(0.16, t + 0.03 + dur - 0.02); g.gain.linearRampToValueAtTime(0, t + 0.03 + dur); // the lips close: p
        o.connect(g);
        for (const [f, q, v] of [[600, 6, 1], [1150, 8, 0.55], [2500, 10, 0.18]]) { const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q; const gg = ac.createGain(); gg.gain.value = v * 3; g.connect(bp); bp.connect(gg); gg.connect(d); }
        o.start(t + 0.03); o.stop(t + 0.05 + dur);
        nz(d, t + 0.03 + dur, 0.025, 'highpass', 1800, 1800, 0.04, 1, 0.002); // the little puff of the p
      },
      land(d, t) { nz(d, t, 0.12, 'lowpass', 450, 80, 0.55); nz(d, t, 0.05, 'bandpass', 2400, 1800, 0.1, 1.5); },
      step(d, t, v) { nz(d, t, 0.045, 'bandpass', rnd(1100, 1700), 900, 0.16 * v, 1.6); nz(d, t, 0.05, 'lowpass', 300, 90, 0.22 * v); },
    };
    // aliases kept for older call sites
    SFX.scream = () => {};
    A.play = (name, x, y, vol = 1) => {
      if (!ac || A.muted || A.hush) return;
      const fn = SFX[name];
      if (!fn) return;
      const d = bus(x, y, vol);
      if (!d) return;
      fn(d, ac.currentTime + 0.005, 1);
    };
    A.step = (x, y) => A.play('step', x, y, 0.8);
    let an = null;
    A.level = () => { if (!ac) return -1; if (!an) { an = ac.createAnalyser(); master.connect(an); } const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let r = 0; for (const v of d) r += v * v; return Math.sqrt(r / d.length); };
    A.stats = () => ({ ann: Object.values(VO.ann).filter(Boolean).length, people: VO.people.length, lines: VO.people.reduce((n, p) => n + Object.values(p).reduce((m, l) => m + l.length, 0), 0), sfx: Object.keys(SFX) });

    // ---------------- voices
    // a burp: a low, gravelly voice sliding down, wobbling, through a mouth-shaped filter
    A.burp = (x, y, v = 0) => {
      if (!ac || A.muted) return;
      const d = bus(x, y, 1.4, voiceG); if (!d) return;
      const t = ac.currentTime, len = 0.45 + (v % 7) * 0.08, f0 = 95 + (v % 5) * 12;
      const o = ac.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 1.35, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.08); o.frequency.exponentialRampToValueAtTime(f0 * 0.72, t + len);
      const vib = ac.createOscillator(), vg = ac.createGain(); vib.frequency.value = 22 + (v % 3) * 5; vg.gain.value = f0 * 0.12; vib.connect(vg); vg.connect(o.frequency);
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 2.2;
      const bp2 = ac.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 1150; bp2.Q.value = 3;
      const g = ac.createGain(), mixg = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + 0.04); g.gain.setValueAtTime(0.9, t + len * 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      const flut = ac.createOscillator(), fg = ac.createGain(); flut.type = 'square'; flut.frequency.value = 31; fg.gain.value = 0.35; flut.connect(fg); fg.connect(g.gain);
      o.connect(bp); o.connect(bp2); bp.connect(mixg); bp2.connect(mixg); mixg.gain.value = 0.8; mixg.connect(g); g.connect(d);
      for (const n of [o, vib, flut]) { n.start(t); n.stop(t + len + 0.05); }
    };
    // a fart: a low buzzing flap, its pitch jittering, a breathy hiss on top, trailing off (sometimes a squeak)
    A.fart = (x, y, v = 0) => {
      if (!ac || A.muted) return;
      const d = bus(x, y, 1.5, voiceG); if (!d) return;
      const t = ac.currentTime, len = 0.35 + (v % 9) * 0.09, f0 = 70 + (v % 6) * 14, squeak = v % 4 === 0;
      const o = ac.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * (squeak ? 2.6 : 0.8), t + len);
      const j = ac.createOscillator(), jg = ac.createGain(); j.type = 'sawtooth'; j.frequency.value = 9 + (v % 5) * 3; jg.gain.value = f0 * 0.35; j.connect(jg); jg.connect(o.frequency);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 6;
      const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.85, t + 0.02); g.gain.setValueAtTime(0.7, t + len * 0.7); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      const flap = ac.createOscillator(), fl = ac.createGain(); flap.type = 'square'; flap.frequency.value = 17 + (v % 4) * 6; fl.gain.value = 0.3; flap.connect(fl); fl.connect(g.gain);
      o.connect(lp); lp.connect(g); g.connect(d);
      const n = ac.createBufferSource(); n.buffer = noise; n.loop = true;
      const nb = ac.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 700; nb.Q.value = 1.2;
      const ng = ac.createGain(); ng.gain.setValueAtTime(0.18, t); ng.gain.exponentialRampToValueAtTime(0.001, t + len + 0.15);
      n.connect(nb); nb.connect(ng); ng.connect(d);
      for (const q of [o, j, flap, n]) { q.start(t); q.stop(t + len + 0.2); }
    };
    A.voice = (who, kind, x, y, vol = 1) => {
      if (!ac || A.muted || !VO.people.length) return;
      const set = VO.people[((who % VO.people.length) + VO.people.length) % VO.people.length][kind];
      if (!set || !set.length) return;
      const d = bus(x, y, vol * 1.3, voiceG);
      if (!d) return;
      const s = ac.createBufferSource(); s.buffer = set[Math.floor(Math.random() * set.length)];
      s.playbackRate.value = rnd(0.96, 1.05);
      s.connect(d); s.start();
    };
    let lastCop = 0;
    A.cop = (kind, x, y) => {
      const set = VO.cop[kind];
      if (!ac || A.muted || !set || !set.length || performance.now() - lastCop < 900) return;
      lastCop = performance.now();
      const d = bus(x, y, 1.3);
      if (!d) return;
      const s = ac.createBufferSource(); s.buffer = set[Math.floor(Math.random() * set.length)];
      // a little radio crackle on the police voice
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.7;
      s.connect(bp); bp.connect(d); s.start();
    };
    let sir = null;
    let chop = null;
    A.chopper = (pos) => {
      if (!ac) return;
      if (!chop) {
        // rotor thump: low noise chopped by a fast pulse
        const src = ac.createBufferSource(); src.buffer = brown || noise; src.loop = true;
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
        const am = ac.createGain(); am.gain.value = 0.35;
        const lfo = ac.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 13; const lg = ac.createGain(); lg.gain.value = 0.32; lfo.connect(lg); lg.connect(am.gain); lfo.start();
        const g = ac.createGain(); g.gain.value = 0;
        const pn = ac.createStereoPanner ? ac.createStereoPanner() : null;
        src.connect(lp); lp.connect(am); am.connect(g); if (pn) { g.connect(pn); pn.connect(master); } else g.connect(master);
        src.start(); chop = { g, pn };
      }
      const t = ac.currentTime;
      if (!pos) { chop.g.gain.setTargetAtTime(0, t, 0.4); return; }
      const d = Math.hypot(pos[0] - lx, pos[1] - ly);
      chop.g.gain.setTargetAtTime(0.9 / (1 + Math.pow(d / 420, 1.6)), t, 0.15);
      if (chop.pn) chop.pn.pan.setTargetAtTime(clamp((pos[0] - lx) / 650, -0.9, 0.9), t, 0.1);
    };
    A.siren = (pos) => {
      if (!ac) return;
      if (!sir) {
        const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 760;
        const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 0.42; lg.gain.value = 260; lfo.connect(lg); lg.connect(o.frequency); lfo.start();
        const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1000; bp.Q.value = 0.8;
        const g = ac.createGain(); g.gain.value = 0;
        const pn = ac.createStereoPanner ? ac.createStereoPanner() : null;
        o.connect(bp); bp.connect(g); if (pn) { g.connect(pn); pn.connect(master); } else g.connect(master);
        const sd = ac.createGain(); sd.gain.value = 0.35; g.connect(sd); sd.connect(revIn);
        o.start(); sir = { g, pn };
      }
      const t = ac.currentTime;
      if (!pos) { sir.g.gain.setTargetAtTime(0, t, 0.3); return; }
      const d = Math.hypot(pos[0] - lx, pos[1] - ly);
      sir.g.gain.setTargetAtTime(0.14 / (1 + Math.pow(d / 350, 1.6)), t, 0.1);
      if (sir.pn) sir.pn.pan.setTargetAtTime(clamp((pos[0] - lx) / 650, -0.9, 0.9), t, 0.1);
    };
    A.announce = (key, text) => {
      if (A.muted) return;
      const b = VO.ann[key];
      if (ac && b) {
        if (ann) try { ann.stop(); } catch {}
        const s = ac.createBufferSource(), g = ac.createGain();
        s.buffer = b; g.gain.value = 1.1; s.connect(g); g.connect(voiceG || master);
        s.start(ac.currentTime + 0.02); ann = s;
        return;
      }
      // clips not loaded yet: fall back to the browser's own speech
      try {
        if (!window.speechSynthesis || !text) return;
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.charAt(0) + text.slice(1).toLowerCase());
        u.rate = 1; u.pitch = 0.85; speechSynthesis.speak(u);
      } catch {}
    };

    // ---------------- engine: firing pulses through gears, with intake noise
    function buildEngine() {
      const out = ac.createGain(); out.gain.value = 0; out.connect(master);
      const send = ac.createGain(); send.gain.value = 0.08; out.connect(send); send.connect(revIn);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 1.5; lp.connect(out);
      const shaper = ac.createWaveShaper();
      const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.tanh(x * 2.2); }
      shaper.curve = c; shaper.connect(lp);
      const mk = (type, g) => { const o = ac.createOscillator(); o.type = type; const gg = ac.createGain(); gg.gain.value = g; o.connect(gg); gg.connect(shaper); o.start(); return o; };
      const o1 = mk('sawtooth', 0.5), o2 = mk('square', 0.3), o3 = mk('sawtooth', 0.2);
      const n = ac.createBufferSource(); n.buffer = brown; n.loop = true;
      const nb = ac.createBiquadFilter(); nb.type = 'bandpass'; nb.Q.value = 2;
      const ng = ac.createGain(); ng.gain.value = 0.35; n.connect(nb); nb.connect(ng); ng.connect(lp); n.start();
      eng = { out, lp, o1, o2, o3, nb };
    }
    const GEARS = [0, 95, 190, 290, 410, 620];
    A.engine = (on, sp, throttle) => {
      if (!eng) return;
      const t = ac.currentTime;
      let g = 1; while (g < GEARS.length - 1 && sp > GEARS[g]) g++;
      const frac = clamp((sp - GEARS[g - 1]) / (GEARS[g] - GEARS[g - 1]), 0, 1);
      const rpm = sp < 5 ? 850 : 1300 + frac * 4300;
      const f = (rpm / 60) * 2; // four cylinders: two firings per revolution
      eng.o1.frequency.setTargetAtTime(f, t, 0.04); eng.o2.frequency.setTargetAtTime(f / 2, t, 0.04); eng.o3.frequency.setTargetAtTime(f * 1.5 * 1.003, t, 0.04);
      eng.nb.frequency.setTargetAtTime(f * 4, t, 0.05);
      eng.lp.frequency.setTargetAtTime(260 + rpm * 0.18 + (throttle ? 500 : 0), t, 0.06);
      eng.out.gain.setTargetAtTime(on ? ((throttle ? 0.2 : 0.11) + Math.min(0.06, sp / 9000)) * (Radio.playing ? 0.5 : 1) : 0, t, on ? 0.08 : 0.2);
    };
    // ---------------- tank: a big V12 diesel (slow, lumpy, growling firing pulses with a turbo whistle on top)
    // and the tracks: steel links clanking over the sprockets faster the faster it rolls, with a squeal when it pivots
    function buildTank() {
      const out = ac.createGain(); out.gain.value = 0; out.connect(master);
      const send = ac.createGain(); send.gain.value = 0.12; out.connect(send); send.connect(revIn);
      const mot = ac.createGain(); mot.gain.value = 0.9; mot.connect(out);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 2.2; lp.connect(mot);
      const shaper = ac.createWaveShaper();
      const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.tanh(x * 4) * 0.9; }
      shaper.curve = c; shaper.connect(lp);
      const mk = (type, g) => { const o = ac.createOscillator(); o.type = type; const gg = ac.createGain(); gg.gain.value = g; o.connect(gg); gg.connect(shaper); o.start(); return o; };
      const o1 = mk('sawtooth', 0.6), o2 = mk('square', 0.45), o3 = mk('sawtooth', 0.25);
      // the lumpy idle: a slow wobble on the volume, like uneven cylinders
      const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 7; lg.gain.value = 0.35; lfo.connect(lg); lg.connect(mot.gain); lfo.start();
      // diesel clatter: noise bursting with the firing rhythm
      const n = ac.createBufferSource(); n.buffer = brown; n.loop = true;
      const nb = ac.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 900; nb.Q.value = 1.4;
      const ng = ac.createGain(); ng.gain.value = 0.25; n.connect(nb); nb.connect(ng); ng.connect(out); n.start();
      // turbo whistle
      const tw = ac.createOscillator(), twg = ac.createGain(); tw.type = 'sine'; tw.frequency.value = 2400; twg.gain.value = 0; tw.connect(twg); twg.connect(out); tw.start();
      // one track link hitting the sprocket: a dull knock plus a short metallic ring
      const sr = ac.sampleRate, len = Math.floor(sr * 0.09), clk = ac.createBuffer(1, len, sr), d = clk.getChannelData(0);
      for (let i = 0; i < len; i++) { const t = i / sr, e = Math.exp(-t * 55); d[i] = (Math.random() * 2 - 1) * e * 0.7 + Math.sin(t * 2 * Math.PI * 1850) * Math.exp(-t * 70) * 0.5 + Math.sin(t * 2 * Math.PI * 140) * Math.exp(-t * 40) * 0.6; }
      const tr = ac.createGain(); tr.gain.value = 0.5; tr.connect(out);
      // the pivot squeal
      const sq = ac.createBufferSource(); sq.buffer = noise; sq.loop = true;
      const sqf = ac.createBiquadFilter(); sqf.type = 'bandpass'; sqf.frequency.value = 2600; sqf.Q.value = 9;
      const sqg = ac.createGain(); sqg.gain.value = 0; sq.connect(sqf); sqf.connect(sqg); sqg.connect(out); sq.start();
      tank = { out, lp, o1, o2, o3, lfo, ng, nb, tw, twg, clk, tr, sqg, ph: 0, rpm: 600, on: false };
    }
    A.tank = (on, sp, throttle, turning) => {
      if (!tank) return;
      const t = ac.currentTime, dA = clamp(t - (tank.lt || t), 0, 0.1); tank.lt = t;
      const v = clamp(Math.abs(sp) / 220, 0, 1);
      const want = throttle ? 1500 + v * 600 : 620 + v * 700 + (turning ? 250 : 0);
      tank.rpm += (want - tank.rpm) * (1 - Math.exp(-dA * (throttle ? 2.5 : 1.6))); // a heavy engine: slow to rev, slow to settle
      const f = tank.rpm / 60 * 6; // twelve cylinders: six firings per revolution
      tank.o1.frequency.setTargetAtTime(f / 2, t, 0.06); tank.o2.frequency.setTargetAtTime(f / 4, t, 0.06); tank.o3.frequency.setTargetAtTime(f / 2 * 1.012, t, 0.06);
      tank.lfo.frequency.setTargetAtTime(tank.rpm / 60 * 1.5, t, 0.1);
      tank.lp.frequency.setTargetAtTime(150 + tank.rpm * 0.12 + (throttle ? 220 : 0), t, 0.08);
      tank.nb.frequency.setTargetAtTime(500 + tank.rpm * 0.4, t, 0.1);
      tank.tw.frequency.setTargetAtTime(1600 + tank.rpm * 1.1, t, 0.25);
      tank.twg.gain.setTargetAtTime(on ? 0.006 + (throttle ? 0.012 : 0) * (0.4 + v) : 0, t, 0.3);
      tank.sqg.gain.setTargetAtTime(on && turning ? (v < 0.15 ? 0.05 : 0.025) : 0, t, 0.12);
      tank.out.gain.setTargetAtTime(on ? 0.3 * (Radio.playing ? 0.55 : 1) : 0, t, on ? 0.15 : 0.35);
      // track clanks: link pitch on the sprocket, faster with speed; turning on the spot still drives the tracks
      if (on) {
        const rate = Math.abs(sp) * 0.09 + (turning ? 6 : 0);
        tank.ph += rate * dA;
        while (tank.ph >= 1) {
          tank.ph -= 1;
          const b = ac.createBufferSource(), g = ac.createGain(); b.buffer = tank.clk; b.playbackRate.value = 0.85 + Math.random() * 0.3;
          g.gain.value = 0.25 + Math.random() * 0.25 + Math.min(0.3, rate / 60); b.connect(g); g.connect(tank.tr); b.start(t + Math.random() * 0.01);
        }
      } else tank.ph = 0;
    };
    // ---------------- speedboat: a buzzing two-stroke outboard (no gears: the revs follow the throttle), the hull
    // slapping through the waves and spray hissing off the sides, louder the faster you go and when you carve a turn
    function buildBoat() {
      const out = ac.createGain(); out.gain.value = 0; out.connect(master);
      const send = ac.createGain(); send.gain.value = 0.05; out.connect(send); send.connect(revIn);
      // the motor: a raspy sawtooth pair through a hard clip, a resonant band like the cowling, and a putter at idle
      const mot = ac.createGain(); mot.gain.value = 0;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 1.2;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
      const shaper = ac.createWaveShaper();
      const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.max(-0.6, Math.min(0.6, x * 3)); }
      shaper.curve = c; shaper.connect(bp); bp.connect(lp); lp.connect(mot); mot.connect(out);
      const mk = (type, g) => { const o = ac.createOscillator(); o.type = type; const gg = ac.createGain(); gg.gain.value = g; o.connect(gg); gg.connect(shaper); o.start(); return o; };
      const o1 = mk('sawtooth', 0.55), o2 = mk('sawtooth', 0.4), o3 = mk('square', 0.18);
      const put = ac.createOscillator(), pg = ac.createGain(); put.type = 'square'; pg.gain.value = 0; put.connect(pg); pg.connect(mot.gain); put.start();
      // the water: low wash with slow wave slaps, and a high spray hiss
      const wn = ac.createBufferSource(); wn.buffer = brown; wn.loop = true;
      const wl = ac.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 500; wl.Q.value = 0.7;
      const wg = ac.createGain(); wg.gain.value = 0; wn.connect(wl); wl.connect(wg); wg.connect(out); wn.start();
      const slap = ac.createOscillator(), sg = ac.createGain(); slap.frequency.value = 1.3; sg.gain.value = 0; slap.connect(sg); sg.connect(wg.gain); slap.start();
      const sn = ac.createBufferSource(); sn.buffer = noise; sn.loop = true;
      const sh = ac.createBiquadFilter(); sh.type = 'bandpass'; sh.frequency.value = 3200; sh.Q.value = 0.9;
      const spg = ac.createGain(); spg.gain.value = 0; sn.connect(sh); sh.connect(spg); spg.connect(out); sn.start();
      boat = { out, mot, bp, lp, o1, o2, o3, put, pg, wg, wl, slap, sg, spg, sh, rpm: 900, slide: 0 };
    }
    A.boat = (on, sp, throttle) => {
      if (!boat) return;
      const t = ac.currentTime, v = clamp(sp / 440, 0, 1);
      // revs chase the throttle quickly, and sag a little under load while the hull is still pushing water
      const want = throttle ? 3600 + v * 3000 : 900 + v * 1600;
      const dA = clamp(t - (boat.lt || t), 0, 0.1); boat.lt = t;
      boat.rpm += (want - boat.rpm) * (1 - Math.exp(-dA * (throttle ? 7 : 3)));
      const f = (boat.rpm / 60) * 2; // a twin two-stroke: two firings a revolution
      boat.o1.frequency.setTargetAtTime(f, t, 0.03); boat.o2.frequency.setTargetAtTime(f * 1.007, t, 0.03); boat.o3.frequency.setTargetAtTime(f / 2, t, 0.03);
      boat.bp.frequency.setTargetAtTime(500 + boat.rpm * 0.22, t, 0.05);
      boat.lp.frequency.setTargetAtTime(1200 + boat.rpm * 0.35, t, 0.05);
      const idle = clamp(1 - (boat.rpm - 900) / 1500, 0, 1); // the putt-putt only at low revs
      boat.put.frequency.setTargetAtTime(f / 4, t, 0.05); boat.pg.gain.setTargetAtTime(0.05 * idle, t, 0.1);
      boat.mot.gain.setTargetAtTime(0.09 + (throttle ? 0.07 : 0.02), t, 0.06);
      boat.wg.gain.setTargetAtTime(0.18 + v * 0.55, t, 0.15); boat.sg.gain.setTargetAtTime(0.1 + v * 0.25, t, 0.2);
      boat.slap.frequency.setTargetAtTime(1 + v * 3.5, t, 0.3);
      boat.wl.frequency.setTargetAtTime(380 + v * 700, t, 0.2);
      boat.spg.gain.setTargetAtTime(v * v * 0.22 + boat.slide * 0.35, t, 0.08);
      boat.sh.frequency.setTargetAtTime(2600 + v * 1400 + boat.slide * 800, t, 0.08);
      boat.out.gain.setTargetAtTime(on ? (Radio.playing ? 0.5 : 1) : 0, t, on ? 0.1 : 0.25);
    };
    A.boatSlide = (amt) => { if (boat) boat.slide = amt; };
    // ---------------- tyre screech: continuous, follows how hard you slide
    function buildSkid() {
      const n = ac.createBufferSource(); n.buffer = noise; n.loop = true;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2900; bp.Q.value = 9;
      const bp2 = ac.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 1700; bp2.Q.value = 6;
      const g = ac.createGain(); g.gain.value = 0;
      n.connect(bp); n.connect(bp2); bp.connect(g); bp2.connect(g); g.connect(master);
      const s = ac.createGain(); s.gain.value = 0.2; g.connect(s); s.connect(revIn);
      const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 7; lg.gain.value = 260; lfo.connect(lg); lg.connect(bp.frequency); lfo.start();
      n.start(); skid = { g, bp };
    }
    A.skid = (amt) => {
      if (!skid) return;
      const t = ac.currentTime;
      skid.g.gain.setTargetAtTime(amt * 0.5, t, amt ? 0.03 : 0.09);
      skid.bp.frequency.setTargetAtTime(2500 + amt * 900, t, 0.05);
    };
    return A;
  })();

  // ================================================================ car radio
  // Each car is tuned to its own station. The server version streams real internet radio
  // (radio-browser.info directory, SomaFM as backup). Inside a claude.ai artifact outside audio
  // is blocked, so it plays stations generated right here in the page.
  const Radio = (() => {
    const SOMA = [
      ['GROOVE SALAD', 'groovesalad'], ['DEF CON RADIO', 'defcon'], ['UNDERGROUND 80S', 'u80s'], ['POPTRON', 'poptron'],
      ['BEAT BLENDER', 'beatblender'], ['METAL DETECTOR', 'metal'], ['SECRET AGENT', 'secretagent'], ['THE TRIP', 'thetrip'],
    ].map(([name, id]) => ({ name, url: `https://ice1.somafm.com/${id}-128-mp3` }));
    const TAGS = ['hiphop', 'rock', 'pop', 'electronic', '80s', 'funk', 'reggae', 'drum and bass'];
    let stations = null, loading = null, audio = null, proc = null, muted = false, carId = 0, tries = 0;
    let vol = Audio.vol('radio') * Audio.vol('master'); // the saved setting (30% at first), before anyone touches the slider
    let on = store.get('cc_radio') !== '0';
    const tuned = new Map(); // car id -> station index
    const show = (name) => { radioMsg = { txt: 'RADIO: ' + name, t: 3.2 }; };
    function loadStations() {
      if (loading) return loading;
      const https = location.protocol === 'https:';
      const q = (tag) => fetch(`https://de1.api.radio-browser.info/json/stations/search?tag=${encodeURIComponent(tag)}&hidebroken=true&order=clickcount&reverse=true&limit=25`)
        .then((r) => r.json()).catch(() => []);
      loading = Promise.all(TAGS.map(q)).then((lists) => {
        const seen = new Set(), out = [];
        for (const l of lists) for (const st of l || []) {
          const url = st.url_resolved || '', codec = String(st.codec || '').toUpperCase();
          if (!url || seen.has(url) || (https && !url.startsWith('https:')) || !/MP3|AAC/.test(codec) || /\.m3u8|\.pls/.test(url)) continue;
          seen.add(url);
          out.push({ name: String(st.name || 'RADIO').replace(/\s+/g, ' ').trim().slice(0, 28).toUpperCase(), url });
        }
        for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
        stations = out.length >= 6 ? out : SOMA.concat(out);
      });
      return loading;
    }
    function stopAll(fade) {
      if (audio) {
        const a = audio; audio = null;
        const v0 = a.volume, t0 = performance.now();
        const step = () => { const f = 1 - (performance.now() - t0) / (fade ? 500 : 1); if (f <= 0) { a.pause(); a.removeAttribute('src'); a.load(); return; } a.volume = v0 * f; requestAnimationFrame(step); };
        step();
      }
      if (proc) { proc.stop(); proc = null; }
    }
    function playProc(id, idx) {
      const ac = Audio.ctx();
      if (!ac) return;
      if (ac.state === 'suspended') ac.resume();
      const n = PROC_STATIONS.length, st = PROC_STATIONS[((idx % n) + n) % n];
      proc = makeProcStation(ac, Audio.radioOut(), Audio.noise(), st, id * 7919 + idx);
      show(st.name);
    }
    function playStream(id) {
      const list = stations && stations.length ? stations : SOMA;
      const idx = tuned.get(id) % list.length, st = list[idx];
      const a = new window.Audio();
      audio = a;
      a.preload = 'none'; a.volume = muted ? 0 : 0.8 * vol; a.src = st.url;
      let ok = false;
      const fail = () => {
        if (ok || audio !== a || carId !== id) return;
        stopAll(false);
        if (++tries <= 3) { tuned.set(id, tuned.get(id) + 1); playStream(id); }
        else playProc(id, tuned.get(id)); // the internet radio isn't reachable: fall back to in-page stations
      };
      a.addEventListener('playing', () => { ok = true; tries = 0; });
      a.addEventListener('error', fail);
      setTimeout(fail, 8000);
      a.play().catch(fail);
      show(st.name);
    }
    function start(id) {
      if (!tuned.has(id)) tuned.set(id, Math.floor(Math.random() * 1000));
      tries = 0;
      if (window.CC_ARTIFACT) { playProc(id, tuned.get(id)); return; }
      loadStations().then(() => { if (carId === id && !audio && !proc) playStream(id); });
    }
    return {
      enter(id) { if (carId === id) return; stopAll(true); carId = id; if (on) start(id); },
      get isOn() { return on; },
      toggle() { on = !on; store.set('cc_radio', on ? '1' : '0'); stopAll(true); if (on && carId) start(carId); return on; },
      get playing() { return !!(audio || proc); },
      exit() { carId = 0; stopAll(true); },
      next() { if (!carId || !on) return; const id = carId; stopAll(false); tuned.set(id, (tuned.get(id) || 0) + 1); tries = 0; if (window.CC_ARTIFACT) playProc(id, tuned.get(id)); else start(id); },
      setMuted(m) { muted = m; if (audio) audio.volume = m ? 0 : 0.8 * vol; },
      setVolume(v) { vol = v; if (audio && !muted) audio.volume = 0.8 * vol; },
    };
  })();

  // ---------------------------------------------------------------- generated stations
  const PROC_STATIONS = [
    { name: 'KRUNK 92.4', bpm: 90, scale: [0, 3, 5, 7, 10], minor: true, root: 41, kick: [0, 7, 10], snare: [4, 12], hat: 2, bass: 'sawtooth', lead: 'square', swing: 0.14, prog: [0, 5, 3, 4] },
    { name: 'NEON DRIVE FM', bpm: 110, scale: [0, 2, 3, 5, 7, 8, 10], minor: true, root: 45, kick: [0, 4, 8, 12], snare: [4, 12], hat: 1, bass: 'sawtooth', lead: 'arp', swing: 0, prog: [0, 5, 2, 6] },
    { name: 'WAREHOUSE 128', bpm: 128, scale: [0, 3, 5, 7, 10], minor: true, root: 40, kick: [0, 4, 8, 12], snare: [4, 12], hat: 3, bass: 'square', lead: 'stab', swing: 0, prog: [0, 0, 3, 0] },
    { name: 'LOW LANE LOFI', bpm: 76, scale: [0, 2, 4, 7, 9], minor: false, root: 43, kick: [0, 10], snare: [4, 12], hat: 2, bass: 'triangle', lead: 'triangle', swing: 0.2, prog: [0, 3, 5, 4] },
    { name: 'TWANG 101', bpm: 104, scale: [0, 2, 4, 5, 7, 9, 11], minor: false, root: 40, kick: [0, 8], snare: [4, 12], hat: 2, bass: 'triangle', lead: 'square', swing: 0.1, prog: [0, 3, 4, 0] },
  ];
  function makeProcStation(ac, out, noise, st, seed) {
    const R = S.rng(seed);
    const bus = ac.createGain(); bus.gain.value = 0;
    bus.gain.setTargetAtTime(0.75, ac.currentTime, 0.3);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; // car speakers
    bus.connect(lp); lp.connect(out);
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const full = st.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const chordOf = (deg) => [0, 2, 4].map((o) => full[(deg + o) % 7] + 12 * Math.floor((deg + o) / 7));
    const env = (t, a, d, peak) => { const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); g.connect(bus); return g; };
    const osc = (type, f, t, a, d, peak, f2) => { const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + a + d); o.connect(env(t, a, d, peak)); o.start(t); o.stop(t + a + d + 0.05); };
    const nz = (t, d, type, f, peak) => { const s = ac.createBufferSource(); s.buffer = noise; const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; s.connect(fl); fl.connect(env(t, 0.002, d, peak)); s.start(t, R() * 0.5); s.stop(t + d + 0.05); };
    // a random riff per car, varied every few bars
    let bassPat, leadPat;
    const newParts = () => {
      bassPat = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 || R() < 0.22 ? (R() < 0.75 ? 0 : 2) : -1));
      leadPat = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 && R() < 0.55 ? Math.floor(R() * st.scale.length) : -1));
    };
    newParts();
    const sd = 60 / st.bpm / 4;
    let next = ac.currentTime + 0.1, stepN = 0;
    const timer = setInterval(() => {
      while (next < ac.currentTime + 0.15) {
        const i = stepN % 16, bar = Math.floor(stepN / 16);
        const t = next + (i % 2 ? st.swing * sd : 0);
        if (i === 0 && bar % 8 === 0 && bar) newParts();
        const ch = chordOf(st.prog[bar % st.prog.length]);
        if (st.kick.includes(i)) osc('sine', 150, t, 0.003, 0.28, 0.9, 42);
        if (st.snare.includes(i)) { nz(t, 0.16, 'bandpass', 1900, 0.5); osc('triangle', 190, t, 0.002, 0.08, 0.25); }
        if ((st.hat === 1) || (st.hat === 2 && i % 2 === 0) || (st.hat === 3 && i % 4 === 2)) nz(t, st.hat === 3 ? 0.09 : 0.04, 'highpass', 7500, st.hat === 3 ? 0.22 : 0.12);
        if (bassPat[i] >= 0) osc(st.bass, hz(st.root + ch[bassPat[i]] - 12), t, 0.005, sd * 1.8, 0.45);
        if (i === 0) for (const n of ch) { osc('triangle', hz(st.root + 12 + n), t, 0.12, sd * 15, 0.1); osc('sawtooth', hz(st.root + n) * 1.003, t, 0.2, sd * 14, 0.025); }
        if (st.lead === 'arp') osc('square', hz(st.root + 24 + ch[i % 3] + (i % 6 > 2 ? 12 : 0)), t, 0.004, sd * 0.8, 0.045);
        else if (st.lead === 'stab') { if (i === 3 || i === 11) for (const n of ch) osc('sawtooth', hz(st.root + 12 + n), t, 0.004, sd * 0.9, 0.05); }
        else if (leadPat[i] >= 0) osc(st.lead, hz(st.root + 24 + st.scale[leadPat[i]]), t, 0.01, sd * 2.2, 0.06);
        next += sd; stepN++;
      }
    }, 25);
    return {
      stop() {
        clearInterval(timer);
        bus.gain.setTargetAtTime(0.0001, ac.currentTime, 0.12);
        setTimeout(() => { try { bus.disconnect(); lp.disconnect(); } catch {} }, 800);
      },
    };
  }
})();
