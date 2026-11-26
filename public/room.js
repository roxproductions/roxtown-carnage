// RoxTown Carnage — in-page transports for the artifact build.
// SOLO: the whole game runs in this page against bots.
// ONLINE ROOM: everyone with the page open shares a city. One player's page runs the game (the host);
// the others send their inputs through room presence and draw the host's compact snapshots.
(() => {
  'use strict';
  const COLORS = S.PLAYER_COLORS;
  const enc = (v) => Math.round(v).toString(36);
  const dec = (s) => parseInt(s, 36) || 0;
  const clean = (t) => String(t).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').slice(0, 120);
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  // ---------------------------------------------------------------- lobby options
  const optEl = document.getElementById('artopts');
  optEl.hidden = false;
  const stEl = document.getElementById('roomst');
  let lobbyMode = store.get('cc_net') || 'online';
  let lobbyBots = 0; // bots start OFF, every time; turn them on (one bot) here, more from the menu in the game
  let lobbySkill = Math.max(1, Math.min(5, +(store.get('cc_skill') || 3)));
  let lobbySize = +(store.get('cc_msize') ?? 1); if (!(lobbySize >= 0 && lobbySize <= 2)) lobbySize = 1;
  let lobbyIsl = +(store.get('cc_isl') ?? 0); if (!(lobbyIsl >= 0 && lobbyIsl <= 2)) lobbyIsl = 0;
  // Who hosts is settled on the start screen: while nobody is playing, the first player on the start screen (lowest
  // room id, preferring a visible tab) hosts, picks the city, and everyone else sees their choices, locked. While a
  // city is running its host's choices are shown instead. Each start screen shares its choices as presence `l`.
  const nameEl = document.getElementById('name');
  const segs = [];
  function seg(id, key, get, set) {
    const el = document.getElementById(id);
    const paint = () => {
      const L = lobbyLead(), v = key && L && !L.me ? L[key] : get();
      [...el.children].forEach((b) => { b.className = b.dataset.v === String(v) ? 'on' : ''; b.disabled = !!(key && L && !L.me); });
    };
    [...el.children].forEach((b) => (b.onclick = () => { if (b.disabled) return; set(b.dataset.v); lobbyShare(); lobbyRefresh(); }));
    segs.push(paint);
  }
  seg('netmode', null, () => lobbyMode, (v) => { lobbyMode = v; store.set('cc_net', v); });
  seg('botsel', 'b', () => lobbyBots, (v) => { lobbyBots = +v; });
  { // bot skill slider
    const el = document.getElementById('skillsel'), nm = document.getElementById('skilln');
    const paint = () => {
      const L = lobbyLead(), lock = !!(L && !L.me);
      if (lock || document.activeElement !== el) el.value = lock ? (L.k || 3) : lobbySkill;
      el.disabled = lock; nm.textContent = S.BOT_SKILLS[+el.value];
    };
    el.oninput = () => { nm.textContent = S.BOT_SKILLS[+el.value]; };
    el.onchange = () => { if (el.disabled) return; lobbySkill = +el.value; store.set('cc_skill', el.value); lobbyShare(); lobbyRefresh(); };
    segs.push(paint);
  }
  seg('msize', 's', () => lobbySize, (v) => { lobbySize = +v; store.set('cc_msize', v); });
  seg('islsel', 'i', () => lobbyIsl, (v) => { lobbyIsl = +v; store.set('cc_isl', v); });

  let room = null, roomState = 'wait'; // wait | ok | none
  let inGame = false, hostedWith = null;
  const myOpts = () => ({ b: lobbyBots, s: lobbySize, i: lobbyIsl, k: lobbySkill });
  // the start screen's choices, shared with everyone in the room (null when playing solo)
  function lobbyShare() {
    if (!room || roomState !== 'ok') return;
    const l = lobbyMode === 'online' ? { ...(hostedWith || myOpts()), n: clean(nameEl.value.trim() || 'Someone').slice(0, 16), z: document.hidden ? 0 : 1 } : null;
    room.presence({ l }).catch(() => {});
  }
  // who decides the city: { me, n, b, s, i, run } or null when the choice is this page's own (solo, or no room)
  function lobbyLead() {
    if (lobbyMode !== 'online' || !room || roomState !== 'ok') return null;
    const peers = room.peers(), now = Date.now();
    const h = peers.filter((p) => p.presence && p.presence.g && p.presence.h && now - p.updatedAt < 4000);
    if (h.length) { // a city is running: its host's choices
      const hp = h.reduce((a, b) => (a.peer < b.peer ? a : b)), l = hp.presence.l || {}, mo = hp.presence.h.mo;
      const o = mo == null ? { s: 1, i: 0 } : { s: (mo >> 2) & 3, i: mo & 3 };
      return { me: hp.sameTab, run: true, n: clean(hp.presence.n || l.n || 'Someone'), b: l.b ?? lobbyBots, k: l.k || 3, s: o.s, i: o.i };
    }
    let c = peers.filter((p) => p.presence && p.presence.l);
    if (!c.length) return { me: true, ...myOpts() };
    const vis = c.filter((p) => p.presence.l.z);
    if (vis.length) c = vis;
    const lp = c.reduce((a, b) => (a.peer < b.peer ? a : b)), l = lp.presence.l;
    return { me: !!lp.sameTab, run: false, n: clean(l.n || 'Someone'), b: l.b | 0, k: l.k || 3, s: l.s | 0, i: l.i | 0 };
  }
  const SIZE = (s) => (S.MAP_SIZES[s] || 'MEDIUM').toLowerCase();
  const cityText = (L) => `${SIZE(L.s)} city${L.i ? ` with ${L.i === 1 ? 'one island' : 'two islands'}` : ''}, ${L.b ? `${L.b} ${L.b === 1 ? 'bot' : 'bots'} (${(S.BOT_SKILLS[L.k || 3] || '').toLowerCase()})` : 'no bots'}`;
  function lobbyStatus() {
    if (lobbyMode === 'solo') { stEl.textContent = 'You against the bots, nobody else joins.'; return; }
    if (roomState === 'wait') { stEl.textContent = 'Looking for other players…'; return; }
    if (roomState === 'none') { stEl.textContent = 'Online play is not available in this view, so you will play solo against bots.'; return; }
    const peers = room.peers();
    const n = peers.filter((p) => p.presence && p.presence.g && !p.sameTab).length;
    const w = peers.filter((p) => p.presence && p.presence.l && !p.presence.g && !p.sameTab).length;
    const L = lobbyLead();
    const waiting = w ? ` ${w} more ${w === 1 ? 'is' : 'are'} on the start screen.` : '';
    if (L.run) stEl.textContent = `${n} ${n === 1 ? 'player is' : 'players are'} in ${L.n}'s ${cityText(L)}. You will join them.${waiting}`;
    else if (L.me) stEl.textContent = w ? `YOU ARE THE HOST: your choices set the city for everyone.${waiting}` : 'Nobody else is here yet. You are the host: anyone who opens this page joins your city.';
    else stEl.textContent = `${L.n.toUpperCase()} IS THE HOST and picks the city. You can hit the streets now or wait for them.`;
  }
  function lobbyRefresh() {
    if (inGame) return;
    for (const p of segs) p(); lobbyStatus();
    const L = lobbyLead(); // someone's already playing in this room: only "join current game"
    if (window.CC_LOBBY_RUNNING) {
      const ps = (room && roomState === 'ok' ? room.peers() : []).filter((p) => p.presence && p.presence.g && !p.sameTab), nm = ps.map((p) => clean(p.presence.n || p.name || '').slice(0, 16)).filter(Boolean).slice(0, 4);
      window.CC_LOBBY_RUNNING(!!(L && L.run), ps.length ? `● ${ps.length} playing now${nm.length ? ' · ' + nm.join(', ') : ''}` : '');
    }
  }
  lobbyRefresh();
  nameEl.addEventListener('input', () => lobbyShare());
  document.addEventListener('visibilitychange', () => lobbyShare());
  const roomListeners = [];
  if (window.claude && claude.use) {
    claude.use('room').then((r) => {
      if (!r) { roomState = 'none'; lobbyRefresh(); return; }
      room = r; roomState = 'ok';
      r.onPeers((ch) => { lobbyRefresh(); for (const f of roomListeners) f(ch); }, () => { roomState = 'none'; lobbyRefresh(); for (const f of roomListeners) f(null); });
      lobbyShare(); lobbyRefresh();
      setInterval(lobbyRefresh, 1000); // a host that quietly went away stops counting after 4 s
    }).catch(() => { roomState = 'none'; lobbyRefresh(); });
  } else { roomState = 'none'; lobbyRefresh(); }

  function runLoop(game, every) {
    let last = performance.now();
    const id = setInterval(() => {
      const n = performance.now();
      game.advance((n - last) / 1000);
      last = n;
      if (every) every(n);
    }, 4);
    return () => clearInterval(id);
  }

  // ---------------------------------------------------------------- solo
  function soloTransport(o) {
    const game = S.createGame({ bots: lobbyBots, botSkill: lobbySkill, mapSize: lobbySize, islands: lobbyIsl });
    if (/[?&]debug\b/.test(location.search)) window.__game = game;
    const conn = game.connect((str) => o.onMsg(JSON.parse(str)));
    conn.message({ t: 'j', n: o.name, c: o.color });
    runLoop(game);
    return { send: (m) => conn.message(m), ok: () => true };
  }

  // ---------------------------------------------------------------- event codec ("type.v.v.v", numbers ×10 in base 36)
  function encEv(e) {
    if (e[0] === 'c') return 'c.' + enc(e[1] * 10) + '.' + String(e[2]);
    let s = e[0];
    for (let i = 1; i < e.length; i++) s += '.' + enc(e[i] * 10);
    return s;
  }
  function decEv(s) {
    const i = s.indexOf('.');
    const t = i < 0 ? s : s.slice(0, i);
    if (t === 'c') { const j = s.indexOf('.', 2); return ['c', dec(s.slice(2, j)) / 10, s.slice(j + 1)]; }
    if (i < 0) return [t];
    return [t, ...s.slice(i + 1).split('.').map((v) => dec(v) / 10)];
  }
  const jsonBytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;

  // ---------------------------------------------------------------- shared room
  function roomTransport(o) {
    const R = room;
    inGame = true;
    const t0 = performance.now();
    let myPeer = null, role = 'none', host = null, noHostSince = performance.now();
    let hiddenSince = document.hidden ? performance.now() : 0;
    let carry = null; // last known scores/time, handed over if this page becomes host
    const F = { peer: null, epoch: null, pres: null, myId: 0, seed: 0, pk: null, cars: new Map(), seenAt: new Map(), lastEv: null, rosterKey: '', roster: [] };
    const inputs = [], actions = [], sentAt = new Map();
    let aseq = 0, cseq = 0;
    const pres = (patch) => R.presence(patch).catch(() => {});
    pres({ g: 1, n: o.name, c: Math.max(0, COLORS.indexOf(o.color)), z: document.hidden ? 0 : 1, h: null, i: null, ac: null, ch: null });
    document.addEventListener('visibilitychange', () => {
      hiddenSince = document.hidden ? performance.now() : 0;
      pres({ z: document.hidden ? 0 : 1 });
    });
    const pkCache = new Map();
    // h.mo = map size * 4 + islands (missing: an older host, medium city without rivers)
    const mapOpts = (mo) => (mo == null ? { size: 1, islands: 0 } : { size: (mo >> 2) & 3, islands: mo & 3 });
    const pickupsFor = (seed, mo) => {
      const key = seed + ':' + mo;
      if (!pkCache.has(key)) pkCache.set(key, S.pickupDefs(S.genMap(seed, mapOpts(mo))).map((d) => [d.id, d.x, d.y, d.k]));
      return pkCache.get(key);
    };

    // ---------------- who hosts?
    function elect() {
      const peers = R.peers();
      const mine = peers.find((p) => p.sameTab);
      if (mine) myPeer = mine.peer;
      if (!myPeer) return;
      const now = Date.now();
      const playing = peers.filter((p) => p.presence && p.presence.g);
      const hosts = playing.filter((p) => !p.sameTab && p.presence.h && now - p.updatedAt < 4000);
      if (role === 'host') {
        const rival = hosts.find((p) => p.peer < myPeer);
        const othersVisible = playing.some((p) => !p.sameTab && p.presence.z);
        if (rival || (hiddenSince && performance.now() - hiddenSince > 2000 && othersVisible)) stopHosting();
        return;
      }
      if (hosts.length) {
        const h = hosts.reduce((a, b) => (a.peer < b.peer ? a : b));
        noHostSince = 0;
        if (F.peer !== h.peer) { F.peer = h.peer; F.epoch = null; F.pres = null; }
        role = 'client';
        return;
      }
      if (!noHostSince) noHostSince = performance.now();
      F.peer = null;
      if (performance.now() - t0 < 1800 || performance.now() - noHostSince < 900) return;
      let cands = playing.filter((p) => (p.sameTab ? !document.hidden : p.presence.z));
      if (!cands.length) cands = playing;
      const pick = cands.reduce((a, b) => (a.peer < b.peer ? a : b), cands[0]);
      if (pick && pick.peer === myPeer) startHosting();
    }
    const electId = setInterval(elect, 200);

    roomListeners.push((ch) => {
      if (!ch) { clearInterval(electId); if (host) host.stop(); o.onClose('LOST THE CONNECTION TO THE ROOM'); return; }
      if (role === 'host') hostPeers(ch.peers);
      else if (F.peer) {
        const hp = ch.peers.find((p) => p.peer === F.peer);
        if (hp && hp.presence.h && hp.presence !== F.pres) { F.pres = hp.presence; follow(hp.presence.h); }
      }
    });

    // ---------------- client side: decode the host's snapshot
    function follow(h) {
      if (h.e !== F.epoch || h.mo !== F.mo) {
        F.epoch = h.e; F.mo = h.mo; F.myId = 0; F.seed = h.s; F.cars.clear(); F.seenAt.clear(); F.lastEv = null; F.rosterKey = '';
      }
      const now = performance.now();
      const rk = h.r.join(',');
      if (rk !== F.rosterKey) {
        F.rosterKey = rk;
        F.roster = h.r.map((s) => { const [id, name, ci, bot, peer] = s.split('|'); return { id: +id, name, color: COLORS[+ci] || COLORS[0], bot: +bot, peer }; });
        const mine = F.roster.find((r) => r.peer === myPeer);
        if (mine && mine.id !== F.myId) { F.myId = mine.id; const mo = mapOpts(h.mo); o.onMsg({ t: 'w', id: mine.id, seed: h.s, ms: mo.size, is: mo.islands, pk: pickupsFor(h.s, h.mo) }); }
        o.onMsg({ t: 'r', l: F.roster.map((r) => [r.id, r.name, r.color, r.bot]) });
      }
      // remember scores so the match carries on if the host leaves
      const sb = h.b.map((s) => s.split('.').map(dec));
      const g = h.g.split('.').map(dec);
      carry = { seed: h.s, mo: h.mo, tl: g[0] ? 0 : g[1], bn: g[5], bs: g[6], byPeer: new Map() };
      for (const r of F.roster) { const row = sb.find((x) => x[0] === r.id); if (r.peer && row) carry.byPeer.set(r.peer, { fr: row[1], de: row[2], sc: row[3] }); }

      for (const s of h.C) {
        const v = s.split('.').map(dec);
        F.cars.set(v[0], [v[0], v[1], v[2], v[3] / 8, v[4] / 8, v[5] / 1000, v[6] / 2, v[7] / 2, v[8], v[9], v[10], v[11] || 0, (v[12] || 0) / 4, (v[13] || 0) / 100]);
        F.seenAt.set(v[0], now);
      }
      const evs = [];
      const first = dec(h.v[0]);
      for (let i = 1; i < h.v.length; i++) {
        const sq = first + i - 1;
        if (F.lastEv !== null && sq <= F.lastEv) continue;
        const e = decEv(h.v[i]);
        if (e[0] === 'rc') { F.cars.delete(e[1]); F.seenAt.delete(e[1]); }
        if (F.lastEv !== null) evs.push(e);
      }
      F.lastEv = Math.max(F.lastEv === null ? -1 : F.lastEv, first + h.v.length - 2);
      for (const [id, t] of F.seenAt) if (now - t > 6000) { F.seenAt.delete(id); F.cars.delete(id); }
      if (!F.myId) return;
      const mrow = h.m.find((s) => s.startsWith(myPeer + '|'));
      if (!mrow) return;
      const [, ack36, base, ped, car, cw] = mrow.split('|');
      const b = base.split('.').map(dec);
      const me = { al: b[0], rs: b[1], hp: b[2], ar: b[3], w: b[4], fr: b[5], sc: b[6], q: b[7], iv: b[8], inv: b.slice(9, 18), wl: b[19] || 0, wi: b[20] || 0, cu: (b[21] || 0) / 10, pp: b[22] || 0, cr: b[23] || 0 };
      if (ped) { const v = ped.split('.').map(dec); me.ped = [v[0] / 64, v[1] / 64, v[2] / 10000, v[3] / 16, v[4] / 16, v[5] / 64, v[6] / 16, v[7] / 16, v[8] / 16, v[9] / 64, v[10] || 0, (v[11] || 0) / 64, v[12] || 0]; }
      if (car) { const v = car.split('.').map(dec); me.car = [v[0] / 64, v[1] / 64, v[2] / 10000, v[3] / 16, v[4] / 16, v[5] / 1000, v[6] / 1000, v[7], v[8] || 0, (v[9] || 0) / 64, (v[10] || 0) / 16, v[11] || 0, v[12] == null ? 100 : v[12]]; }
      me.cw = cw ? cw.split('.').map(dec) : null;
      const ack = dec(ack36);
      if (sentAt.has(ack)) o.onMsg({ t: 'po', c: sentAt.get(ack) });
      o.onMsg({
        t: 's', tm: h.t, a: ack, me,
        P: h.P.map((s) => { const v = s.split('.').map(dec); return [v[0], v[1] / 8, v[2] / 8, v[3] / 1000, v[4], v[5], v[6], v[7], v[8], v[9] / 4]; }),
        C: [...F.cars.values()],
        PR: h.R.map((s) => { const v = s.split('.').map(dec); return [v[0], v[1], v[2] / 2, v[3] / 2, v[4] === undefined ? 9 : v[4] / 10]; }),
        pk: h.k, ev: evs,
        g: { st: g[0] ? 'over' : 'play', tl: g[1], fl: g[2], win: g[3], po: g[4] || 0, bn: g[5] || 0, bs: g[6] || 3, du: h.D && h.D.length ? h.D.map((s) => s.split('.').map(dec)) : undefined, rc: typeof h.RC === 'string' ? h.RC.split('.').map(dec) : undefined },
        N: (h.N || []).map((s) => { const v = s.split('.').map(dec); return [v[0], v[1] / 4, v[2] / 4, v[3] / 100, v[4], v[5], v[6] || 0]; }),
        sb: sb.map((r) => [r[0], r[1], r[2], r[3], 0]),
      });
    }

    // ---------------- host side
    function startHosting() {
      role = 'host'; F.peer = null;
      const cr = carry;
      // the city the start screen agreed on (the lobby host's choices), unless a running match is being carried over
      const L = lobbyLead(), pick = L && !L.run ? { b: L.b, s: L.s, i: L.i, k: L.k } : myOpts();
      hostedWith = cr ? { ...pick, s: mapOpts(cr.mo).size, i: mapOpts(cr.mo).islands, ...(cr.bn != null ? { b: cr.bn, k: cr.bs } : {}) } : pick;
      const H = { epoch: Math.random().toString(36).slice(2, 8), remotes: new Map(), ring: [], evSeq: 0, latest: null, lastPub: 0, carSent: new Map(), rot: 0 };
      const game = S.createGame({
        bots: hostedWith.b, botSkill: hostedWith.k || 3, peds: 14, seed: cr ? cr.seed : 0,
        mapSize: hostedWith.s, islands: hostedWith.i,
        traffic: [5, 7, 9][hostedWith.s], // a little lighter: every moving car has to fit in the host's presence
        timeLeft: cr && cr.tl > 10 ? cr.tl : 0, queueMax: 45, queueKeep: 15,
        onSnap: (snap) => {
          H.latest = snap;
          const now = performance.now();
          for (const e of snap.ev) H.ring.push({ q: H.evSeq++, t: now, s: encEv(e) });
          while (H.ring.length && now - H.ring[0].t > 1000) H.ring.shift();
        },
      });
      H.game = game;
      if (/[?&]debug\b/.test(location.search)) window.__game = game;
      H.carryOf = (peer) => (cr && cr.byPeer.get(peer)) || null;
      H.local = game.connect((str) => o.onMsg(JSON.parse(str)));
      H.local.message({ t: 'j', n: o.name, c: o.color, peer: myPeer, carry: H.carryOf(myPeer), quiet: !!cr });
      H.stop = runLoop(game, (now) => { if (now - H.lastPub >= 50 && H.latest) { H.lastPub = now; publish(); } });
      host = H;
      lobbyShare(); // the start screens show the city this page is running
      hostPeers(R.peers());
    }
    function stopHosting() {
      if (!host) return;
      host.stop(); host = null; role = 'none'; noHostSince = performance.now();
      pres({ h: null });
    }
    function hostPeers(peers) {
      const H = host, seen = new Set();
      for (const pr of peers) {
        const pz = pr.presence;
        if (pr.sameTab || !pz || !pz.g) continue;
        seen.add(pr.peer);
        let r = H.remotes.get(pr.peer);
        if (!r) {
          r = { conn: H.game.connect(null), pres: null, lastA: -1, lastCh: -1 };
          H.remotes.set(pr.peer, r);
          const c = H.carryOf(pr.peer);
          r.conn.message({ t: 'j', n: clean(pz.n || 'Player'), c: COLORS[pz.c | 0] || COLORS[0], peer: pr.peer, carry: c, quiet: !!c });
          if (typeof pz.ac === 'string') { const [f, codes] = pz.ac.split(':'); r.lastA = dec(f) + (codes || '').length - 1; }
          if (Array.isArray(pz.ch)) r.lastCh = pz.ch[0] | 0;
        }
        if (pz === r.pres) continue;
        r.pres = pz;
        if (typeof pz.i === 'string') {
          const [f, body] = pz.i.split(':'), first = dec(f), l = [];
          let s = first;
          for (const run of (body || '').split('.')) {
            if (run.length < 3) continue;
            const k = parseInt(run.slice(0, 2), 16) | 0, n = Math.min(240, dec(run.slice(2)));
            for (let j = 0; j < n; j++) l.push([s++, k]);
          }
          r.conn.message({ t: 'i', l, v: pz.v | 0 }); // the game ignores the ones it already has
        }
        if (typeof pz.ac === 'string') {
          const [f, codes] = pz.ac.split(':'), first = dec(f);
          for (let j = 0; j < (codes || '').length; j++) if (first + j > r.lastA) { r.lastA = first + j; r.conn.message({ t: 'a', a: codes[j] }); }
        }
        if (Array.isArray(pz.ch) && (pz.ch[0] | 0) > r.lastCh) { r.lastCh = pz.ch[0] | 0; r.conn.message({ t: 'c', m: clean(pz.ch[1] || '') }); }
      }
      for (const [peer, r] of H.remotes) if (!seen.has(peer)) { r.conn.close(); H.remotes.delete(peer); }
    }
    function publish() {
      const H = host, snap = H.latest, game = H.game;
      const P = snap.P.map((r) => [r[0], r[1] * 8, r[2] * 8, r[3] * 1000, r[4], r[5], r[6], r[7], r[8], r[9] * 4].map(enc).join('.'));
      const C = [], incl = new Set(), live = new Set();
      for (const r of snap.C) {
        live.add(r[0]);
        const s = [r[0], r[1], r[2], r[3] * 8, r[4] * 8, r[5] * 1000, r[6] * 2, r[7] * 2, r[8], r[9], r[10], r[11] || 0, (r[12] || 0) * 4, Math.round((r[13] || 0) * 100)].map(enc).join('.');
        let cs = H.carSent.get(r[0]);
        if (!cs || cs.s !== s) { cs = { s, n: 4 }; H.carSent.set(r[0], cs); }
        if (cs.n > 0) { cs.n--; C.push(s); incl.add(r[0]); }
      }
      for (const id of H.carSent.keys()) if (!live.has(id)) H.carSent.delete(id);
      const rot = [];
      for (let k = 0; k < snap.C.length && rot.length < 6; k++) {
        const r = snap.C[(H.rot + k) % snap.C.length];
        if (!incl.has(r[0])) rot.push(H.carSent.get(r[0]).s);
      }
      H.rot = (H.rot + 6) % Math.max(1, snap.C.length);
      const roster = [...game.players.values()].map((p) => `${p.id}|${p.name}|${Math.max(0, COLORS.indexOf(p.color))}|${p.bot ? 1 : 0}|${p.peer || ''}`);
      const m = [];
      for (const { p, me, a } of snap.mes) {
        if (!p.peer || p.peer === myPeer) continue;
        const base = [me.al, me.rs, me.hp || 0, me.ar || 0, me.w, me.fr, me.sc, me.q, me.iv, ...me.inv, 0, me.wl || 0, me.wi || 0, (me.cu || 0) * 10, me.pp || 0, me.cr || 0].map(enc).join('.');
        const ped = me.ped ? [me.ped[0] * 64, me.ped[1] * 64, me.ped[2] * 10000, me.ped[3] * 16, me.ped[4] * 16, me.ped[5] * 64, me.ped[6] * 16, me.ped[7] * 16, me.ped[8] * 16, me.ped[9] * 64, me.ped[10] || 0, (me.ped[11] || 0) * 64, me.ped[12] || 0].map(enc).join('.') : '';
        const car = me.car ? [me.car[0] * 64, me.car[1] * 64, me.car[2] * 10000, me.car[3] * 16, me.car[4] * 16, me.car[5] * 1000, me.car[6] * 1000, me.car[7], me.car[8] || 0, (me.car[9] || 0) * 64, (me.car[10] || 0) * 16, me.car[11] || 0, me.car[12] == null ? 100 : me.car[12]].map(enc).join('.') : '';
        const cw = me.cw ? me.cw.map(enc).join('.') : '';
        m.push(`${p.peer}|${enc(a)}|${base}|${ped}|${car}|${cw}`);
      }
      const ring = H.ring.slice();
      const h = {
        e: H.epoch, s: game.seed, mo: game.map.size * 4 + game.map.islands, t: snap.tm,
        g: [snap.g.st === 'play' ? 0 : 1, snap.g.tl, snap.g.fl, snap.g.win, snap.g.po || 0, snap.g.bn || 0, snap.g.bs || 3].map(enc).join('.'),
        N: snap.N.map((r) => [r[0], r[1] * 4, r[2] * 4, r[3] * 100, r[4], r[5], r[6] || 0].map(enc).join('.')),
        k: snap.pk, r: roster,
        b: snap.sb.map((r) => [r[0], r[1], r[2], r[3]].map(enc).join('.')),
        P, C: C.concat(rot), R: snap.PR.map((r) => [r[0], r[1], r[2] * 2, r[3] * 2, (r[4] === undefined ? 9 : r[4]) * 10].map(enc).join('.')),
        v: null, m,
      };
      if (snap.g.du) h.D = snap.g.du.map((r) => r.map(enc).join('.')); // car fist fights in progress
      if (snap.g.rc) h.RC = snap.g.rc.map(enc).join('.'); // race mode
      const setV = () => { h.v = [enc(ring.length ? ring[0].q : H.evSeq), ...ring.map((x) => x.s)]; };
      setV();
      // stay inside the 4 KiB presence budget: drop the rotation first, then the oldest events, then cars
      if (jsonBytes(h) > 3700) h.C = C;
      while (jsonBytes(h) > 3700 && h.N.length > 6) h.N.pop();
      while (jsonBytes(h) > 3700 && ring.length) { ring.shift(); setV(); }
      while (jsonBytes(h) > 3700 && h.C.length) h.C.pop();
      pres({ h });
    }

    // ---------------- transport API used by client.js
    return {
      interp: 170,
      ok: () => true,
      leave() { try { R.presence({ g: null, h: null, i: null }).catch(() => {}); if (R.leave) R.leave(); } catch {} }, // quit: off the room's list at once
      send(msg) {
        if (role === 'host' && host) { host.local.message(msg); return; }
        if (msg.t === 'i') {
          const now = performance.now();
          for (const x of msg.l) { inputs.push(x); sentAt.set(x[0], now); }
          // every update carries the last ~2 s of keys, run-length encoded (keys rarely change, so it stays short):
          // even a relay that only passes on a few updates a second loses none of them
          while (inputs.length > 120) inputs.shift();
          if (sentAt.size > 400) for (const k of [...sentAt.keys()].slice(0, 200)) sentAt.delete(k);
          const runs = [];
          for (const x of inputs) { const k = x[1] & 255; if (runs.length && runs[runs.length - 1][0] === k) runs[runs.length - 1][1]++; else runs.push([k, 1]); }
          pres({ v: msg.v | 0, i: inputs[0][0].toString(36) + ':' + runs.map(([k, n]) => k.toString(16).padStart(2, '0') + n.toString(36)).join('.') });
        } else if (msg.t === 'a') {
          actions.push(++aseq + ':' + msg.a);
          while (actions.length > 8) actions.shift();
          pres({ ac: (aseq - actions.length + 1).toString(36) + ':' + actions.map((x) => x.split(':')[1]).join('') });
        } else if (msg.t === 'c') {
          pres({ ch: [++cseq, clean(msg.m)] });
        }
      },
    };
  }

  window.CC_ARTIFACT = true; // the artifact frame blocks outside audio, so the car radio is generated in-page
  window.CC_TRANSPORT = (o) => (lobbyMode === 'online' && room && roomState === 'ok' ? roomTransport(o) : soloTransport(o));
})();
