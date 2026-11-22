// RoxTown Carnage — the authoritative game simulation. Runs in Node (server.js) or in a browser page (solo / room host).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { require('./fight.js'); module.exports = factory(require('./shared.js')); }
  else factory(root.S);
})(typeof self !== 'undefined' ? self : this, function (S) {
  const { T, K, TILE, DT } = S;
  const PK_POOL = [1, 2, 2, 3, 3, 4, 5, 6, 6, 7, 8, 0, 20, 20, 21, 21, 22, 23];
  // pickup crates are fixed per map, so clients can rebuild them from the seed
  S.pickupDefs = function (map) {
    const out = [];
    map.pickupSpots.forEach((s, i) => out.push({ id: i, x: s.x, y: s.y, k: PK_POOL[i % PK_POOL.length] }));
    map.cwSpots.forEach((s, i) => out.push({ id: out.length, x: s.x, y: s.y, k: 30 + (i % 4) }));
    return out;
  };

  S.createGame = function (opts = {}) {
  let FILL_BOTS = opts.bots !== undefined ? Math.max(0, Math.min(8, opts.bots | 0)) : 1; // how many bots play (with at least one human in)
  let BOT_SKILL = Math.max(1, Math.min(5, opts.botSkill | 0 || 3)); // 1 rookie .. 5 psycho
  // per skill: how often a bot rethinks (s), how far off it aims (rad), how long it needs to see you before it fires
  // (s), and how far it spots you (px). Skill 3 is how the bots always played.
  const BOT_MISS = 0.2; // bots' shots wander this much (radians, either way) after the aim assist: about half their shots miss
  const SKILL = [null,
    { think: 0.5, err: 0.5, react: 1.1, sight: 420, dmg: 0.6 },
    { think: 0.32, err: 0.28, react: 0.75, sight: 560, dmg: 0.8 },
    { think: 0.15, err: 0.12, react: 0.4, sight: 700, dmg: 1 },
    { think: 0.1, err: 0.06, react: 0.25, sight: 780, dmg: 1.25 },
    { think: 0.06, err: 0.025, react: 0.12, sight: 850, dmg: 1.5 }]; // dmg: how hard a bot's hits land on players
  const FRAG_LIMIT = opts.frags || 10;
  const TIME_LIMIT = (opts.minutes || 10) * 60;
  const ARSENAL = !!opts.arsenal; // everyone spawns with every weapon
  const SEED = opts.seed || Math.floor(Math.random() * 1e6);
  const QMAX = opts.queueMax || 8, QKEEP = opts.queueKeep || 3;

  // ------------------------------------------------------------------ world
  const MAPO = { size: opts.mapSize == null ? 1 : opts.mapSize, islands: opts.islands | 0 };
  const map = S.genMap(SEED, MAPO);
  let nextId = 1;
  const players = new Map();
  const cars = new Map();
  let projs = [];
  let hazards = [];
  const pickups = [];
  let events = [];
  let time = 0, tick = 0;
  let state = 'play', matchEnd = opts.timeLeft || TIME_LIMIT, overUntil = 0, winner = 0;
  const rand = Math.random;
  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const ev = (e) => events.push(e);

  // pickups
  for (const d of S.pickupDefs(map)) pickups.push({ id: d.id, x: d.x, y: d.y, k: d.k, active: true, at: 0 });

  // cars
  function pickCarType() {
    const r = rand();
    return r < 0.2 ? 0 : r < 0.3 ? 1 : r < 0.48 ? 2 : r < 0.6 ? 3 : r < 0.72 ? 4 : r < 0.84 ? 5 : r < 0.9 ? 6 : 7;
  }
  function makeCar(spot) {
    const t = pickCarType();
    const c = {
      id: nextId++, t, col: t === 3 ? 5 : Math.floor(rand() * S.CAR_COLORS.length),
      x: spot.x, y: spot.y, a: spot.a, vx: 0, vy: 0, spin: 0, oil: 0, hp: S.CARS[t].hp,
      driver: 0, drv: false, dead: false, burn: 0, removeAt: 0, lastAtk: 0, lastAtkT: -99, lastDriver: 0, lastDriverT: -99, cws: [0, 0, 0, 0], cwk: 0, up: 0, z: 0, vz: 0,
    };
    // here and there a car comes with one or two upgrades
    if (rand() < 0.2) {
      const pool = [S.UP.TURBO, S.UP.ARMOR, S.UP.GRIP, S.UP.ARMED];
      const n = rand() < 0.3 ? 2 : 1;
      for (let i = 0; i < n; i++) c.up |= pool[Math.floor(rand() * pool.length)];
      if (c.up & S.UP.ARMED) { const k = Math.floor(rand() * 3); c.cws[k] = Math.round(S.CARWEAPONS[k].pick * 1.5); c.cwk = k; }
      c.hp = S.carStats(c).hp;
    }
    if (S.carHits(map, c)) return null;
    for (const o of cars.values()) if (Math.hypot(o.x - c.x, o.y - c.y) < 70) return null;
    cars.set(c.id, c);
    return c;
  }
  for (const s of map.carSpots) makeCar(s);
  // hidden helicopters on top of the tall buildings (see genMap); one comes back to its pad a while after it crashes
  const HELI = S.HELI;
  const heliRespawn = [];
  function spawnHeli(pi) {
    const pad = map.helipads[pi];
    const c = { id: nextId++, t: HELI, col: [3, 1, 4, 0][pi % 4], x: pad.x, y: pad.y, a: pad.a, vx: 0, vy: 0, spin: 0, oil: 0, hp: 999,
      driver: 0, drv: false, dead: false, burn: 0, removeAt: 0, lastAtk: 0, lastAtkT: -99, lastDriver: 0, lastDriverT: -99,
      cws: [0, 0, 0, 0, S.CARWEAPONS[4].pick], cwk: 4, up: 0, z: pad.z, vz: 0, hm: 0, pad: pi, idleT: 0 };
    cars.set(c.id, c);
    return c;
  }
  map.helipads.forEach((_, i) => spawnHeli(i));
  // the army tank on its street, speedboats at their moorings, and the fire trucks that come out when a car burns.
  // Tank and boats come back to their spot a while after they're wrecked or left lying around.
  const TANK = S.TANK, BOAT = S.BOAT, FIRE = S.FIRE;
  const homeRespawn = [];
  function special(t, x, y, a, extra) {
    return Object.assign({ id: nextId++, t, col: 0, x, y, a, vx: 0, vy: 0, spin: 0, oil: 0, hp: S.CARS[t].hp, driver: 0, drv: false, dead: false, burn: 0, removeAt: 0,
      lastAtk: 0, lastAtkT: -99, lastDriver: 0, lastDriverT: -99, cws: [0, 0, 0, 0], cwk: 0, up: 0, z: 0, vz: 0 }, extra);
  }
  function spawnHome(kind, i) {
    const s = kind === 'tank' ? map.tankSpot : map.boats[i];
    if (!s) return false;
    const c = kind === 'tank' ? special(TANK, s.x, s.y, s.a, { home: 'tank', homeI: 0, col: 0 })
      : special(BOAT, s.x, s.y, s.a, { home: 'boat', homeI: i, col: [0, 4, 2, 6][i % 4], cws: [999, 0, 0, 0], cwk: 0 }); // the boat's minigun never runs dry
    if (S.carHits(map, c)) return false;
    for (const o of cars.values()) if (Math.hypot(o.x - c.x, o.y - c.y) < 60) return false;
    cars.set(c.id, c);
    return true;
  }
  // at the start, parked cars make room for the tank and boats; anything still blocked waits in the respawn queue
  const clearHome = (s, r) => { if (s) for (const o of [...cars.values()]) if (!o.home && !o.driver && Math.hypot(o.x - s.x, o.y - s.y) < r) cars.delete(o.id); };
  if (map.tankSpot) { clearHome(map.tankSpot, 70); if (!spawnHome('tank', 0)) homeRespawn.push({ kind: 'tank', i: 0, at: 0 }); }
  (map.boats || []).forEach((s, i) => { clearHome(s, 60); if (!spawnHome('boat', i)) homeRespawn.push({ kind: 'boat', i, at: 0 }); });
  // ---- the fire brigade: a car catches fire and a fire truck comes (out of sight, then up the road), parks near
  // it and hoses it down with its water cannon. Put out in time, the car survives as a smoking wreck. Then it drives
  // off. The water cannon knocks people over (and puts them out if they're burning). Jack a fire truck and the
  // cannon is yours: Ctrl.
  const FIRE_MAX = 2;
  function callFireTruck(target) {
    if (target.t === HELI || target.t === BOAT || MAXPEDS === 0) return;
    const trucks = [...cars.values()].filter((c) => c.fireAI);
    if (trucks.length >= FIRE_MAX || trucks.some((c) => c.fireAI.target === target.id)) return;
    const idle = trucks.find((c) => c.fireAI.state === 'leave');
    if (idle) { idle.fireAI.target = target.id; idle.fireAI.state = 'go'; return; }
    for (let i = 0; i < 50; i++) {
      const ang = rand() * Math.PI * 2, dist = 420 + rand() * 380;
      const tx = Math.floor((target.x + Math.cos(ang) * dist) / TILE), ty = Math.floor((target.y + Math.sin(ang) * dist) / TILE);
      if (S.tile(map, tx, ty) !== T.ROAD) continue;
      const vert = map.roadCols.has(tx), hor = map.roadRows.has(ty);
      if (vert === hor) continue;
      const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
      if (nearAnyone(x, y, 380)) continue;
      const a = Math.atan2(target.y - y, target.x - x), sa = vert ? (Math.sin(a) > 0 ? Math.PI / 2 : -Math.PI / 2) : (Math.cos(a) > 0 ? 0 : Math.PI);
      const c = special(FIRE, x, y, sa, { col: 1, siren: true, fireAI: { target: target.id, state: 'go', k: 0, spray: 0, born: time } });
      if (S.carHits(map, c) || [...cars.values()].some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 80)) continue;
      cars.set(c.id, c);
      return;
    }
  }
  function waterCannon(c, a, by) {
    const C = S.CARS[c.t], ox = c.x + Math.cos(c.a) * (C.len / 2 - 14), oy = c.y + Math.sin(c.a) * (C.len / 2 - 14), R = 190;
    ev(['ws', c.id, r3(a)]);
    const inJet = (x, y) => { const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy); return d < R && d > 4 && Math.abs(S.angDiff(Math.atan2(dy, dx), a)) < 0.22 + 10 / d && S.los(map, ox, oy, x, y); };
    for (const q of cars.values()) {
      if (q === c || q.dead || (q.z || 0) > 10 || !inJet(q.x, q.y)) continue;
      if (q.burn > 0) { q.douse = (q.douse || 0) + 0.1; q.burn = Math.min(5, q.burn + 0.12); if (q.douse > 2.2) { q.burn = 0; q.douse = 0; q.hp = Math.max(q.hp, 25); ev(['xo', q.id]); } }
      q.vx += Math.cos(a) * 18 / S.CARS[q.t].mass; q.vy += Math.sin(a) * 18 / S.CARS[q.t].mass;
    }
    for (const q of players.values()) {
      if (!q.alive || q.ped.car || q.duel || q.id === by || !inJet(q.ped.x, q.ped.y)) continue;
      q.ped.fire = 0; q.ped.kx += Math.cos(a) * 140; q.ped.ky += Math.sin(a) * 140; q.ped.nj = 0.6;
    }
    for (const n of npcs.values()) {
      if (n.duel || !inJet(n.x, n.y)) continue;
      n.fire = 0; n.kx += Math.cos(a) * 140; n.ky += Math.sin(a) * 140;
      if (n.kind === 0) { n.panic = time + 3; n.wx = undefined; }
    }
  }
  function stepFireTrucks() {
    // an empty burning car smoulders on until the fire brigade gets there (25 s at most); if no truck could set out, keep calling
    for (const q of cars.values()) {
      if (!(q.burn > 0) || q.dead || q.driver || q.t === HELI || q.t === BOAT || MAXPEDS === 0) continue;
      q.burnT = (q.burnT || 0) + DT;
      let coming = false; for (const f of cars.values()) if (f.fireAI && f.fireAI.target === q.id && f.fireAI.state === 'go') { coming = true; break; }
      if (!coming && Math.floor(q.burnT * 2) !== Math.floor((q.burnT - DT) * 2)) { callFireTruck(q); continue; }
      if (coming && q.burn < 1.2 && q.burnT < 25) q.burn = 1.2;
    }
    for (const c of [...cars.values()]) {
      const F = c.fireAI;
      if (!F) continue;
      if (c.dead || c.burn > 0 || c.driver) { c.fireAI = null; c.siren = false; continue; } // wrecked or taken: the crew's gone
      let tgt = F.target && cars.get(F.target);
      if (!tgt || tgt.dead || !(tgt.burn > 0)) {
        // that one's out (or gone up): anything else burning nearby?
        tgt = null;
        for (const q of cars.values()) if (q.burn > 0 && !q.dead && q.t !== HELI && q.t !== BOAT && Math.hypot(q.x - c.x, q.y - c.y) < 1300) { tgt = q; break; }
        F.target = tgt ? tgt.id : 0; F.state = tgt ? 'go' : 'leave';
      }
      if (F.state === 'leave') {
        c.siren = false;
        F.k = F.away ? botDrive(F, c, F.away[0], F.away[1], 0.6, false) : 0;
        if (!F.away) { const sp = map.carSpots[Math.floor(rand() * map.carSpots.length)]; F.away = [sp.x, sp.y]; }
        if (!nearAnyone(c.x, c.y, 650) || time - F.born > 120) { cars.delete(c.id); ev(['rc', c.id]); }
        continue;
      }
      c.siren = true; F.away = null;
      const d = Math.hypot(tgt.x - c.x, tgt.y - c.y), a = Math.atan2(tgt.y - c.y, tgt.x - c.x);
      if (d < 175 && S.los(map, c.x, c.y, tgt.x, tgt.y)) {
        // in range: stop and hose it down
        const v = Math.hypot(c.vx, c.vy);
        F.k = v > 25 ? K.DOWN : 0;
        F.spray -= DT;
        if (F.spray <= 0) { F.spray = 0.1; waterCannon(c, a, 0); }
      } else F.k = botDrive(F, c, tgt.x, tgt.y, 0.7, false);
    }
  }
  function stepHomeRespawn() {
    for (let i = homeRespawn.length - 1; i >= 0; i--) {
      const r = homeRespawn[i], s = r.kind === 'tank' ? map.tankSpot : map.boats[r.i];
      if (time < r.at || !s || nearAnyone(s.x, s.y, 420)) continue;
      if ([...cars.values()].some((c) => c.home === r.kind && c.homeI === r.i)) { homeRespawn.splice(i, 1); continue; }
      if (spawnHome(r.kind, r.i)) homeRespawn.splice(i, 1);
    }
  }
  let carRespawnQueue = 0;
  // Cars someone drove and then left behind fade out after a minute; cars still in their parked spot stay.
  const ABANDON = 60, ABANDON_FADE = 2;
  // Lag compensation: each car remembers where it was over the last second, so the host can judge a
  // player on foot against the cars as that player saw them (their screen runs a little behind the host).
  const HIST = 64, LAG_MAX = 1.0;
  const pose = { x: 0, y: 0, a: 0, vx: 0, vy: 0, z: 0 };
  function recPos(o, x, y, z) {
    if (!o.ph) o.ph = new Float64Array(HIST * 4);
    const i = (tick % HIST) * 4; o.ph[i] = tick; o.ph[i + 1] = x; o.ph[i + 2] = y; o.ph[i + 3] = z;
  }
  const spot = { x: 0, y: 0, z: 0 };
  // where a player or person was `back` ticks ago (now, if we don't know)
  function seenAt(o, back, x, y, z) {
    if (back > 0 && o.ph) { const tk = tick - back, i = (((tk % HIST) + HIST) % HIST) * 4; if (o.ph[i] === tk) { spot.x = o.ph[i + 1]; spot.y = o.ph[i + 2]; spot.z = o.ph[i + 3]; return spot; } }
    spot.x = x; spot.y = y; spot.z = z; return spot;
  }
  // a shooter aims at what their screen shows, so their shots are judged against that (up to 0.7 s back)
  const shotBack = (p) => (p && !p.bot && !p.copN && !p.crewing ? Math.min(42, Math.round((p.view || 0) / DT)) : 0); // (a crew's shots happen now, not on its boss's lagged screen)
  function carAsSeen(c, back) {
    const h = c.hist;
    if (back > 0 && h) {
      const tk = tick - back, o = (((tk % HIST) + HIST) % HIST) * 7;
      if (h[o] === tk) { pose.x = h[o + 1]; pose.y = h[o + 2]; pose.a = h[o + 3]; pose.vx = h[o + 4]; pose.vy = h[o + 5]; pose.z = h[o + 6]; return pose; }
    }
    pose.x = c.x; pose.y = c.y; pose.a = c.a; pose.vx = c.vx; pose.vy = c.vy; pose.z = c.z || 0;
    return pose;
  }
  function sweepAbandoned() {
    const busy = new Set();
    for (const n of npcs.values()) if (n.car) busy.add(n.car);
    for (const d of duels.values()) busy.add(d.car);
    for (const p of players.values()) if (p.cuff && time < p.cuff.until) busy.add(p.cuff.car);
    for (const c of cars.values()) {
      if (c.driver || c.ai || c.fireAI || busy.has(c.id) || c.dead || c.t === HELI) { c.usedT = time; c.fadeAt = 0; continue; }
      if (!(c.lastDriverT > -50 || c.cop || c.wasTraffic)) continue; // never moved: still a parked car
      const last = Math.max(c.lastDriverT, c.usedT || 0);
      if (!c.fadeAt && time - last > ABANDON) c.fadeAt = time;
    }
  }
  function dropAbandoned(c) {
    if ((c.cop || c.wasTraffic) && !c.home) { cars.delete(c.id); ev(['rc', c.id]); }
    else removeCar(c); // a fresh parked car turns up somewhere out of sight
  }
  // points for taking out people on the street add up (10 a pedestrian, 20 for a splat, 30 a cop): every 100 gives
  // +25 health, never past 100. Frags, car-jackings and fist-fight wins score too, but don't count towards health.
  function streetPoints(p, pts) {
    p.score += pts;
    p.hpPts = (p.hpPts || 0) + pts;
    while (p.hpPts >= 100) {
      p.hpPts -= 100;
      if (p.alive && p.ped && p.ped.hp < 100) { p.ped.hp = Math.min(100, p.ped.hp + 25); ev(['hu', p.id]); }
    }
  }
  function removeCar(c) {
    cars.delete(c.id); ev(['rc', c.id]);
    if (c.home) homeRespawn.push({ kind: c.home, i: c.homeI, at: time + (c.home === 'tank' ? 45 : 30) }); // back at its spot later
    else if (c.t !== FIRE) carRespawnQueue++;
  }

  // ------------------------------------------------------------------ players
  const BOT_NAMES = ['Rico', 'Slim', 'Duke', 'Moose', 'Vito', 'Ziggy', 'Lefty', 'Spud', 'Dino', 'Gus', 'Weasel', 'Boomer'];
  function newPlayer(name, color, bot) {
    const p = {
      id: nextId++, name, color, bot, send: null, peer: null, alive: false, respawnAt: time + 0.3,
      ped: null, inv: new Array(9).fill(0), w: 0, cd: 0, frags: 0, deaths: 0, score: 0,
      q: [], k: 0, curK: 0, lastSeq: 0, view: 0, quad: 0, invis: 0, lastAtk: 0, lastAtkT: -99, fireBy: 0,
      bt: 0, target: 0, wp: null, aimErr: 0, seen: 0, lastPos: null, stuckT: 0, turnT: 0, turnDir: 1,
    };
    players.set(p.id, p);
    return p;
  }
  function spawnPlayer(p) {
    // spawn near the action, but not on top of anyone: nearest rival 450..1300 units away if possible
    const others = [...players.values()].filter((q) => q.alive && q !== p);
    const good = [];
    let best = null, bd = -1;
    for (const s2 of map.spawns) {
      let md = 1e9;
      for (const q of others) md = Math.min(md, Math.hypot(q.ped.x - s2.x, q.ped.y - s2.y));
      if (md >= 450 && md <= 1300) good.push(s2);
      if (md > bd) { bd = md; best = s2; }
    }
    if (good.length) best = good[Math.floor(rand() * good.length)];
    p.ped = { x: best.x, y: best.y, a: rand() * Math.PI * 2 - Math.PI, kx: 0, ky: 0, hp: 100, ar: 0, fire: 0, car: 0, mv: 0, z: 0, vz: 0, jvx: 0, jvy: 0, gz: 0 };
    p.inv.fill(0); p.inv[0] = 50;
    if (p.bot && rand() < 0.75) { const w = 1 + Math.floor(rand() * 8); p.inv[w] = S.WEAPONS[w].pick; } // bots come back armed with something
    if (ARSENAL) S.WEAPONS.forEach((w, i) => (p.inv[i] = Math.max(p.inv[i], w.pick))); p.w = 0; p.cd = 0.3; p.alive = true; p.quad = 0; p.invis = 0; p.lastAtk = 0;
    p.q.length = 0; p.heat = 0;
    ev(['sp', p.id]);
  }
  function syncBots() {
    const humans = [...players.values()].filter((p) => !p.bot).length;
    const bots = [...players.values()].filter((p) => p.bot);
    const want = humans === 0 ? 0 : FILL_BOTS;
    let changed = false;
    while (bots.length < want) {
      const used = new Set(bots.map((b) => b.name));
      const nm = BOT_NAMES.find((n) => !used.has('[BOT] ' + n)) || 'Bot' + nextId;
      bots.push(newPlayer('[BOT] ' + nm, S.PLAYER_COLORS[Math.floor(rand() * S.PLAYER_COLORS.length)], true));
      changed = true;
    }
    while (bots.length > want) { removePlayer(bots.pop()); changed = true; }
    if (changed) sendRoster();
  }
  function removePlayer(p) {
    if (p.alive && p.ped.car) { const c = cars.get(p.ped.car); if (c) { c.driver = 0; c.lastDriver = 0; c.lastDriverT = time; } }
    players.delete(p.id);
    if (p.duel) { const d = duels.get(p.duel); if (d) endDuel(d, d.A === p ? 1 : 0, true); }
  }

  // ------------------------------------------------------------------ damage
  function damagePed(q, dmg, atk, cause) {
    if (!q.alive || q.ped.car || q.duel) return;
    const ped = q.ped;
    if (atk) { const a = players.get(atk); if (a && a.quad > 0) dmg *= 2; if (a && a.bot && !q.bot) dmg *= SKILL[BOT_SKILL].dmg; }
    if (ped.ar > 0) { const ab = Math.min(ped.ar, dmg * 0.7); ped.ar -= ab; dmg -= ab; }
    ped.hp -= dmg;
    if (dmg > 0) ped.nj = 0.6; // being shot (or burnt, or hit) pins you down: you can't jump for a moment
    if (atk && atk !== q.id) { q.lastAtk = atk; q.lastAtkT = time; }
    if (ped.hp <= 0) killPlayer(q, atk, cause);
  }
  function killPlayer(q, atk, cause) {
    if (!q.alive) return;
    if (q.duel && cause !== 52 && cause !== 53 && cause !== 50 && cause !== 54) return;
    q.cuff = null;
    const ped = q.ped;
    q.alive = false; q.respawnAt = time + 3.5; q.deaths++;
    if (q.ride && q.ride.length) { for (const r of q.ride) ev(['pk', r.id, r1(ped.x), r1(ped.y), 0, 21, 0, 2, 0]); q.ride = []; } // your crew goes down with the car
    if (ped.car) { const c = cars.get(ped.car); if (c && c.driver === q.id) { c.driver = 0; c.lastDriver = q.id; c.lastDriverT = time; } ped.car = 0; }
    let kid = atk;
    if ((!kid || kid === q.id) && q.lastAtk && time - q.lastAtkT < 6) kid = q.lastAtk;
    const k = kid ? players.get(kid) : null;
    q.heat = 0;
    if (k && k !== q) { k.frags++; k.score += 1000 * (cause === 20 ? 2 : 1); }
    else if (cause !== 50 && cause !== 51 && cause !== 26 && cause !== 54) { q.frags--; q.score = Math.max(0, q.score - 500); }
    ev(['k', q.id, k && k !== q ? k.id : 0, cause, r1(ped.x), r1(ped.y), r3(ped.a)]);
    if (state === 'play' && k && k !== q && k.frags >= FRAG_LIMIT) endMatch();
  }
  function damageCar(c, dmg, atk) {
    if (c.dead || c.duel || c.t === HELI) return;
    if (atk) { const a = players.get(atk); if (a && a.quad > 0) dmg *= 2; c.lastAtk = atk; c.lastAtkT = time; }
    if (c.up & S.UP.ARMOR) dmg *= 0.6;
    c.hp -= dmg;
    if (c.ai && atk && c.hp < S.carStats(c).hp * 0.6) { const a = players.get(atk); bailOut(c, a && a.ped); }
    if (c.hp <= 0 && c.burn <= 0) { c.burn = 5; c.burnT = 0; c.douse = 0; ev(['cf', c.id]); callFireTruck(c); } // on fire: 5 s to get out (or away), and the fire brigade's on its way
    if (c.hp < -100) explodeCar(c);
  }
  function explodeCar(c) {
    if (c.dead) return;
    c.dead = true; c.burn = 0; c.removeAt = time + 30; c.cws = [0, 0, 0, 0];
    c.vx *= 0.4; c.vy *= 0.4; c.spin = (rand() - 0.5) * 3;
    const atk = c.lastAtk && time - c.lastAtkT < 10 ? c.lastAtk : 0;
    if (c.driver) { const d = players.get(c.driver); c.driver = 0; if (d) killPlayer(d, atk, 24); }
    explosion(c.x, c.y, 135, 120, atk, c.id, 0.5); // a car going up is scary, but not a guaranteed kill for bystanders
  }
  function explosion(x, y, R, D, owner, srcCar, pedMul = 1, ez = 0) {
    ev(['x', r1(x), r1(y), R]);
    const PR = R * (pedMul < 1 ? 0.85 : 1);
    for (const q of players.values()) {
      if (!q.alive || q.ped.car) continue;
      const dx = q.ped.x - x, dy = q.ped.y - y, d = Math.hypot(dx, dy, (q.ped.z - ez) * 1.5);
      if (d > PR || (q.ped.z < 20 && ez < 20 && !S.los(map, x, y, q.ped.x, q.ped.y))) continue;
      const f = 1 - d / PR;
      q.ped.kx += (dx / (d || 1)) * 420 * f; q.ped.ky += (dy / (d || 1)) * 420 * f;
      damagePed(q, D * pedMul * f * f, owner, 21); // falls off steeply: only a near hit does real damage
    }
    alarm(x, y, 520);
    if (ez < 20) for (const n of [...npcs.values()]) {
      const dx = n.x - x, dy = n.y - y, d = Math.hypot(dx, dy);
      if (d > PR || !S.los(map, x, y, n.x, n.y)) continue;
      const f = 1 - d / PR;
      n.kx += (dx / (d || 1)) * 420 * f; n.ky += (dy / (d || 1)) * 420 * f;
      damageNpc(n, D * pedMul * f * f * 1.3, owner, 21);
    }
    for (const c of cars.values()) {
      if (c.id === srcCar || (owner && c.driver === owner)) continue; // your own weapons never hurt the car you're driving
      const dx = c.x - x, dy = c.y - y, d = Math.max(0, Math.hypot(dx, dy, ez * 1.5) - 14);
      if (d > R) continue;
      const f = 1 - d / R, m = S.carStats(c).mass;
      c.vx += ((dx / (d || 1)) * 260 * f) / m; c.vy += ((dy / (d || 1)) * 260 * f) / m; c.spin += ((rand() - 0.5) * 6 * f) / m;
      damageCar(c, D * 1.2 * f, owner);
    }
  }

  // ------------------------------------------------------------------ weapons
  function rayCircle(ox, oy, dx, dy, cx, cy, r) {
    const fx = ox - cx, fy = oy - cy, b = fx * dx + fy * dy, c = fx * fx + fy * fy - r * r, disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : null;
  }
  function rayCar(ox, oy, dx, dy, c) {
    const C = S.CARS[c.t], ca = Math.cos(c.a), sa = Math.sin(c.a);
    const px = ox - c.x, py = oy - c.y;
    const lx = px * ca + py * sa, ly = -px * sa + py * ca, ldx = dx * ca + dy * sa, ldy = -dx * sa + dy * ca;
    let t0 = -1e9, t1 = 1e9;
    for (const [o, d, h] of [[lx, ldx, C.len / 2], [ly, ldy, C.wid / 2]]) {
      if (Math.abs(d) < 1e-9) { if (Math.abs(o) > h) return null; continue; }
      let a = (-h - o) / d, b = (h - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    return t0 <= t1 && t0 >= 0 ? t0 : null;
  }
  function hitscan(p, ox, oy, a, range, dmg, w, ignoreCar, sz = 0) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = range, kind = 0, hit = null;
    const wall = (x, y) => S.heightAt(map, x, y) > sz + 10;
    if (!p.copN) noticeShot(p, ox, oy);
    if (wall(ox, oy)) { best = 0; kind = 3; }
    else for (let t = 6; t < range; t += 6) if (wall(ox + dx * t, oy + dy * t)) { best = t; kind = 3; break; }
    const back = shotBack(p);
    if (sz <= 20) for (const n of npcs.values()) {
      if (p.copN && n.kind === 1) continue;
      if (n.owner && n.owner === p.id) continue; // your own crew: you shoot past them
      if (p.gangN && n.kind === 2 && !n.owner) continue; // nor at their own gang
      const o = seenAt(n, back, n.x, n.y, 0);
      const t = rayCircle(ox, oy, dx, dy, o.x, o.y, 10);
      if (t !== null && t < best) { best = t; kind = 4; hit = n; }
    }
    for (const q of players.values()) {
      if (q === p || !q.alive || q.ped.car) continue;
      const o = seenAt(q, back, q.ped.x, q.ped.y, q.ped.z || 0);
      if (Math.abs(o.z - sz) > 20) continue; // bullets fly at the shooter's height
      const t = rayCircle(ox, oy, dx, dy, o.x, o.y, 11);
      if (t !== null && t < best) { best = t; kind = 1; hit = q; }
    }
    for (const c of cars.values()) {
      if (c.id === ignoreCar || sz > 20) continue;
      const P = back ? carAsSeen(c, back) : c;
      const t = rayCar(ox, oy, dx, dy, back ? { t: c.t, x: P.x, y: P.y, a: P.a } : c);
      if (t !== null && t < best) { best = t; kind = 2; hit = c; }
    }
    if (kind === 1) { damagePed(hit, dmg, p.id, w); hit.ped.kx += dx * 40; hit.ped.ky += dy * 40; }
    if (kind === 2) damageCar(hit, dmg * 0.6, p.id);
    if (kind === 4) { damageNpc(hit, dmg, p.id, w); hit.kx += dx * 40; hit.ky += dy * 40; }
    ev(['s', r1(ox), r1(oy), r1(ox + dx * best), r1(oy + dy * best), kind === 4 ? 1 : kind, w, p.id || 0]);
  }
  function coneTargets(p, ox, oy, a, range, cone, ownCar, sz = 0) {
    const out = [];
    if (sz <= 20) for (const n of npcs.values()) {
      if (n.owner && n.owner === p.id) continue;
      const dx = n.x - ox, dy = n.y - oy, d = Math.hypot(dx, dy);
      if (d < range && Math.abs(S.angDiff(Math.atan2(dy, dx), a)) < cone + 10 / (d + 1) && S.los(map, ox, oy, n.x, n.y)) out.push({ n, d });
    }
    for (const q of players.values()) {
      if (q === p || !q.alive || q.ped.car || Math.abs(q.ped.z - sz) > 20) continue;
      const dx = q.ped.x - ox, dy = q.ped.y - oy, d = Math.hypot(dx, dy);
      if (d < range && Math.abs(S.angDiff(Math.atan2(dy, dx), a)) < cone + 10 / (d + 1) && S.los(map, ox, oy, q.ped.x, q.ped.y)) out.push({ q, d });
    }
    for (const c of cars.values()) {
      if (c.id === ownCar || c.dead || sz > 20) continue;
      const dx = c.x - ox, dy = c.y - oy, d = Math.hypot(dx, dy);
      if (d < range + 15 && Math.abs(S.angDiff(Math.atan2(dy, dx), a)) < cone + 20 / (d + 1) && S.los(map, ox, oy, c.x, c.y)) out.push({ c, d });
    }
    return out.sort((u, v) => u.d - v.d);
  }
  function fire(p) {
    const ped = p.ped;
    let ox, oy, a, ca, sa, ignoreCar = 0, sz = ped.z || 0;
    if (ped.car) {
      // from behind the wheel you only have the car's own weapons
      const c = cars.get(ped.car);
      if (!c) return;
      if (c.t === FIRE && !p.footSel) { p.cd = 0.1; waterCannon(c, c.a, p.id); return; } // the fire truck's water cannon
      if (c.t === TANK && !p.footSel) {
        // the tank's cannon: a shell out of the barrel, as often as it can reload
        p.cd = 1.1;
        const ta = Math.cos(c.a), tb = Math.sin(c.a), ox = c.x + ta * 44, oy = c.y + tb * 44;
        projs.push({ id: nextId++, k: 1, x: ox, y: oy, z: 6, vx: ta * 720 + c.vx, vy: tb * 720 + c.vy, life: 1.8, owner: p.id, born: time, shell: true });
        ev(['r', r1(ox), r1(oy)]); ev(['tk', c.id]);
        noticeShot(p, c.x, c.y);
        return;
      }
      const k = p.footSel ? -1 : cwSel(c);
      if (k < 0) return;
      const W = S.CARWEAPONS[k], C = S.CARS[c.t];
      ca = Math.cos(c.a); sa = Math.sin(c.a);
      if (W.id === 'missile') {
        // from a helicopter in the air: a missile that streaks down onto the street ahead
        if (c.hm !== 1 || c.z < 60) { p.cd = 0.1; return; }
        p.cd = W.rate; c.cws[k]--;
        const sp = 620, reach = 300, z0 = c.z - 8;
        projs.push({ id: nextId++, k: 1, x: c.x + ca * 30, y: c.y + sa * 30, z: z0, vz: -z0 / (reach / sp), vx: ca * sp + c.vx, vy: sa * sp + c.vy, life: 2.2, owner: p.id, born: time });
        ev(['r', r1(c.x), r1(c.y)]);
        if (c.cws[k] <= 0) c.crashAt = time + 1.3; // that was the last one: down it goes
        return;
      }
      if (W.id === 'jump') {
        // only from the ground: hop as high as a jump on foot
        if (S.carAir(map, c)) { p.cd = 0.05; return; }
        p.cd = W.rate; c.cws[k]--;
        c.vz = S.CAR_JUMP; c.z = (c.z || 0) + 0.01;
        ev(['cj', c.id, r1(c.x), r1(c.y)]);
        cwSel(c);
        return;
      }
      p.cd = W.rate; c.cws[k]--;
      if (c.t === BOAT && W.id === 'cmg') { p.cd = W.rate * 0.45; c.cws[k] = Math.max(c.cws[k], 999); } // the boat's minigun: twice as fast, never empty
      if (W.id === 'cmg') {
        for (const side of [-1, 1]) {
          const lx = C.len / 2 + 4, ly = side * (C.wid / 2 - 4);
          hitscan(p, c.x + lx * ca - ly * sa, c.y + lx * sa + ly * ca, c.a + (rand() - 0.5) * (p.bot ? 0.05 + BOT_MISS : 0.05), W.range, W.dmg, 30, c.id, c.z || 0); // at the car's height (up on a roof)
        }
      } else {
        const bx = c.x - ca * (C.len / 2 + 16), by = c.y - sa * (C.len / 2 + 16);
        hazards.push({ id: nextId++, k: W.id === 'oil' ? 5 : 6, x: bx, y: by, life: W.id === 'oil' ? 30 : 120, owner: p.id, arm: time + 1 });
        ev(['d', r1(bx), r1(by), W.id === 'oil' ? 0 : 1]);
      }
      cwSel(c);
      return;
    } else {
      if (p.w === S.FISTS) return punch(p);
      if (p.inv[p.w] <= 0) { autoSwitch(p); return; } // out of ammo: next gun, or fists
      a = autoAim(p, ped.x, ped.y, ped.a, S.WEAPONS[p.w].range || 500);
      if (p.bot) a += (rand() - 0.5) * BOT_MISS;
      ca = Math.cos(a); sa = Math.sin(a);
      ox = ped.x + ca * 14; oy = ped.y + sa * 14;
    }
    const w = p.w, W = S.WEAPONS[w];
    p.cd = W.rate; p.inv[w]--;
    const spr = () => (rand() - 0.5) * 2 * (W.spread || 0);
    switch (W.id) {
      case 'pistol': case 'mg': hitscan(p, ox, oy, a + spr(), W.range, W.dmg, w, ignoreCar, sz); break;
      case 'dual':
        for (const s of [-1, 1]) hitscan(p, ox - sa * 5 * s, oy + ca * 5 * s, a + spr(), W.range, W.dmg, w, ignoreCar, sz);
        break;
      case 'shotgun': for (let i = 0; i < W.pellets; i++) hitscan(p, ox, oy, a + spr(), W.range * (0.8 + rand() * 0.2), W.dmg, w, ignoreCar, sz); break;
      case 'electro': {
        const pts = [r1(ox), r1(oy)];
        const tg = coneTargets(p, ox, oy, a, W.range, 0.4, ignoreCar, sz);
        if (!tg.length) {
          let t = 8; while (t < 140 && !S.solid(map, ox + ca * t, oy + sa * t)) t += 8;
          pts.push(r1(ox + ca * t), r1(oy + sa * t));
        } else {
          let cur = tg[0];
          const hitSet = new Set();
          for (let j = 0; j < 3 && cur; j++) {
            const tx = cur.q ? cur.q.ped.x : cur.n ? cur.n.x : cur.c.x, ty = cur.q ? cur.q.ped.y : cur.n ? cur.n.y : cur.c.y;
            pts.push(r1(tx), r1(ty));
            if (cur.n) { damageNpc(cur.n, j ? 6 : W.dmg, p.id, w); break; }
            if (cur.q) { hitSet.add(cur.q); damagePed(cur.q, j ? 6 : W.dmg, p.id, w); }
            else damageCar(cur.c, j ? 4 : 6, p.id);
            if (!cur.q) break;
            let nb = null, nd = 140;
            for (const q of players.values()) {
              if (q === p || !q.alive || q.ped.car || hitSet.has(q)) continue;
              const d = Math.hypot(q.ped.x - tx, q.ped.y - ty);
              if (d < nd && S.los(map, tx, ty, q.ped.x, q.ped.y)) { nd = d; nb = { q }; }
            }
            cur = nb;
          }
        }
        ev(['z', ...pts]);
        break;
      }
      case 'flamer': {
        ev(['f', r1(ox), r1(oy), r3(a), p.id]);
        for (const t of coneTargets(p, ox, oy, a, W.range, 0.3, ignoreCar, sz)) {
          if (t.q) { t.q.ped.fire = Math.max(t.q.ped.fire, 3); t.q.fireBy = p.id; damagePed(t.q, W.dmg, p.id, w); }
          else if (t.n) { t.n.fire = Math.max(t.n.fire, 3); t.n.fireBy = p.id; damageNpc(t.n, W.dmg, p.id, w); }
          else damageCar(t.c, 2.6, p.id);
        }
        break;
      }
      case 'rocket':
        projs.push({ id: nextId++, k: 1, x: ox, y: oy, z: sz, vx: ca * 640, vy: sa * 640, life: 2.2, owner: p.id, born: time });
        ev(['r', r1(ox), r1(oy)]);
        break;
      case 'grenade': case 'molotov': {
        const sp = W.id === 'grenade' ? 440 : 400;
        projs.push({ id: nextId++, k: W.id === 'grenade' ? 2 : 3, x: ox, y: oy, z: sz, vx: ca * sp + (ped.car ? 0 : ped.kx * 0.3), vy: sa * sp + (ped.car ? 0 : ped.ky * 0.3), life: W.id === 'grenade' ? 1.7 : 0.75, owner: p.id, born: time });
        ev(['t', r1(ox), r1(oy)]);
        break;
      }
    }
    if (p.inv[w] <= 0) autoSwitch(p);
  }
  // gentle aim assist: snap toward the closest on-foot target inside a narrow cone
  function autoAim(p, x, y, a, range) {
    let best = a, bd = 0.13;
    const back = shotBack(p);
    for (const q of players.values()) {
      if (q === p || !q.alive || q.ped.car || q.invis > 0) continue;
      const o = seenAt(q, back, q.ped.x, q.ped.y, q.ped.z || 0);
      if (Math.abs(o.z - (p.ped.z || 0)) > 20) continue;
      const dx = o.x - x, dy = o.y - y, d = Math.hypot(dx, dy);
      if (d > range || d < 1) continue;
      const df = Math.abs(S.angDiff(Math.atan2(dy, dx), a));
      if (df < bd && S.los(map, x, y, o.x, o.y)) { bd = df; best = Math.atan2(dy, dx); }
    }
    return best;
  }
  // out of ammo: fists, as in GTA2
  function punch(p) {
    const ped = p.ped;
    p.cd = 0.25; p.lastPunch = time; // a pedestrian takes 4 punches, a player 12
    let best = null, bd = 30;
    for (const q of players.values()) {
      if (q === p || !q.alive || q.ped.car || Math.abs(q.ped.z - ped.z) > 20) continue;
      const dx = q.ped.x - ped.x, dy = q.ped.y - ped.y, d = Math.hypot(dx, dy);
      if (d < bd && Math.abs(S.angDiff(Math.atan2(dy, dx), ped.a)) < 0.9) { bd = d; best = q; }
    }
    let bestN = null;
    if (ped.z < 20) for (const n of npcs.values()) {
      const dx = n.x - ped.x, dy = n.y - ped.y, d = Math.hypot(dx, dy);
      if (d < bd && Math.abs(S.angDiff(Math.atan2(dy, dx), ped.a)) < 0.9) { bd = d; bestN = n; best = null; }
    }
    if (bestN) { bestN.kx += Math.cos(ped.a) * 180; bestN.ky += Math.sin(ped.a) * 180; damageNpc(bestN, 9, p.id, 40); if (bestN.kind === 0 && npcs.has(bestN.id)) addHeat(p, 3); }
    if (best) {
      best.ped.kx += Math.cos(ped.a) * 180; best.ped.ky += Math.sin(ped.a) * 180;
      damagePed(best, 9, p.id, 40);
    }
    ev(['u', r1(ped.x + Math.cos(ped.a) * 14), r1(ped.y + Math.sin(ped.a) * 14), best || bestN ? 1 : 0, p.id]);
  }
  function autoSwitch(p) {
    const pref = [6, 2, 3, 4, 5, 1, 8, 7, 0];
    for (const w of pref) if (p.inv[w] > 0) { p.w = w; return; }
    p.w = S.FISTS;
  }
  // the selected car weapon (switching to another one if it ran dry), or -1
  function cwSel(c) {
    if (!c || !c.cws) return -1;
    if (c.cws[c.cwk] > 0) return c.cwk;
    const i = c.cws.findIndex((n) => n > 0);
    if (i >= 0) c.cwk = i;
    return i;
  }
  // Z/X: one list. In a car with mounted weapons it runs through the car's weapons first and then your own (fists
  // last); while one of your own is picked, Ctrl does nothing until you get out, and that's the gun in your hand.
  function cycleWeapon(p, dir) {
    const c = p.ped.car ? cars.get(p.ped.car) : null;
    const foot = [];
    for (let w = 0; w < 10; w++) if (w === S.FISTS || p.inv[w] > 0) foot.push(w);
    const slots = c && c.cws ? [0, 1, 2, 3].filter((k) => c.cws[k] > 0) : [];
    if (!slots.length) {
      const i = Math.max(0, foot.indexOf(p.w));
      p.w = foot[(i + dir + foot.length) % foot.length];
      return;
    }
    const ring = slots.map((k) => [1, k]).concat(foot.map((w) => [0, w]));
    let i = p.footSel ? ring.findIndex((r) => !r[0] && r[1] === p.w) : ring.findIndex((r) => r[0] && r[1] === c.cwk);
    if (i < 0) i = 0;
    const [car, v] = ring[(i + dir + ring.length) % ring.length];
    if (car) { c.cwk = v; p.footSel = false; } else { p.w = v; p.footSel = true; }
  }

  // secret chop shops: drive in slowly and you come out with a fresh paint job, a random car weapon, and the police
  // off your back. Each shop serves you once a minute.
  const SHOP_R = 30, SHOP_WAIT = 60;
  function chopShop(c, p) {
    if (!map.shops || S.carAir(map, c) || (c.z || 0) > 1 || Math.hypot(c.vx, c.vy) > 140) return;
    for (let i = 0; i < map.shops.length; i++) {
      const sh = map.shops[i];
      if (Math.abs(c.x - sh.x) > SHOP_R || Math.abs(c.y - sh.y) > SHOP_R) continue;
      p.shopAt = p.shopAt || {};
      if (time < (p.shopAt[i] || 0)) return;
      p.shopAt[i] = time + SHOP_WAIT;
      let col = c.col;
      while (col === c.col) col = Math.floor(rand() * S.CAR_COLORS.length);
      c.col = col;
      const k = Math.floor(rand() * 4); // vehicle gun, oil, mines or car jump
      c.cws[k] = Math.min(999, c.cws[k] + Math.round(S.CARWEAPONS[k].pick * 1.5));
      c.cwk = k; p.footSel = false;
      p.heat = 0;
      c.vx *= 0.2; c.vy *= 0.2; c.oil = 0;
      ev(['sh', c.id, i, col, k, p.id]);
      return;
    }
  }

  // ------------------------------------------------------------------ cars: enter/exit
  function exitCar(p, thrown) {
    const ped = p.ped, c = cars.get(ped.car);
    ped.car = 0;
    if (!c) return;
    c.driver = 0; c.lastDriver = p.id; c.lastDriverT = time;
    dropRiders(p, c);
    const C = S.CARS[c.t], rx = -Math.sin(c.a), ry = Math.cos(c.a);
    if (c.t === HELI) {
      // step out beside it, at its height (a roof, or the street)
      ped.x = c.x + rx * (C.wid / 2 + 14); ped.y = c.y + ry * (C.wid / 2 + 14);
      ped.a = c.a; ped.z = c.z || 0; ped.vz = 0; ped.gz = 0; ped.jvx = 0; ped.jvy = 0; ped.kx = 0; ped.ky = 0;
      return;
    }
    if (c.t === BOAT) {
      // out of a boat: onto the nearest dry land within a jump; out on open water there's only the river
      let best = null;
      for (let r = C.wid / 2 + 10; r < 170 && !best; r += 10) for (let i = 0; i < 24; i++) {
        const an = (i / 24) * Math.PI * 2, x = c.x + Math.cos(an) * r, y = c.y + Math.sin(an) * r;
        if (S.tileW(map, x, y) !== T.WATER && !S.solid(map, x, y) && !S.solid(map, x + 8, y) && !S.solid(map, x - 8, y) && !S.solid(map, x, y + 8) && !S.solid(map, x, y - 8)) { best = { x, y }; break; }
      }
      ped.x = best ? best.x : c.x + rx * (C.wid / 2 + 12); ped.y = best ? best.y : c.y + ry * (C.wid / 2 + 12);
      ped.a = c.a; ped.z = 0; ped.vz = 0; ped.gz = 0; ped.jvx = 0; ped.jvy = 0; ped.kx = 0; ped.ky = 0;
      S.collideCircle(map, ped, S.PED.r, 0);
      return;
    }
    const off = C.wid / 2 + 12, z0 = c.z || 0;
    // a wall for someone stepping out at the car's height (up on a roof, the roof itself is floor)
    const solid = (x, y) => S.solid(map, x, y) && S.heightAt(map, x, y) > z0 + 6;
    let placed = false;
    for (const side of [-1, 1, 0]) {
      const x = side ? c.x + rx * side * off : c.x - Math.cos(c.a) * (C.len / 2 + 12), y = side ? c.y + ry * side * off : c.y - Math.sin(c.a) * (C.len / 2 + 12);
      if (!solid(x, y) && !solid(x + 8, y) && !solid(x - 8, y) && !solid(x, y + 8) && !solid(x, y - 8)) {
        ped.x = x; ped.y = y; placed = true;
        if (thrown) { ped.kx = rx * side * 220; ped.ky = ry * side * 220; }
        break;
      }
    }
    if (!placed) { ped.x = c.x; ped.y = c.y; }
    ped.kx += c.vx * 0.5; ped.ky += c.vy * 0.5;
    ped.a = c.a; ped.z = z0; ped.vz = 0; ped.gz = 0; ped.jvx = 0; ped.jvy = 0; // up on a roof: you step out onto it
    S.collideCircle(map, ped, S.PED.r, ped.z || 0);
  }
  function actEnter(p, only) { // only: a bot going for that one vehicle, and not whatever happens to be nearest
    if (!p.alive || state !== 'play' || p.duel) return;
    const ped = p.ped;
    if (ped.car) {
      const hc = cars.get(ped.car);
      // in a flying helicopter, Enter sets it down (on whatever is below) and you get out once it has landed
      if (hc && hc.t === HELI && hc.hm !== 0) { if (hc.hm === 1) { hc.hm = 2; hc.exitOnLand = true; } return; }
      exitCar(p, false); ev(['e', p.id, 0]); return;
    }
    let best = null, bd = 1e9;
    for (const c of cars.values()) {
      if (c.dead || c.burn > 0 || c.duel || (only && c !== only)) continue;
      // heights: you can jack a car while you're in the middle of a jump, or grab one that's jumping past you, but
      // not one up on a roof while you're down in the street (the helicopter on its roof needs you up there)
      const dz = (ped.z || 0) - (c.z || 0);
      if (dz < -45 || dz > 60 || (c.t === HELI && (c.hm !== 0 || Math.abs(dz) > 24))) continue;
      const C = S.CARS[c.t], d = Math.hypot(c.x - ped.x, c.y - ped.y);
      const sp = Math.hypot(c.vx, c.vy), air = S.carAir(map, c) || (ped.z || 0) > 2;
      if (d < C.len / 2 + 80 + Math.min(50, sp * 0.2) && d < bd && sp < (air ? 420 : 200)) { bd = d; best = c; }
    }
    if (!best) return;
    if (p.cuff && time < p.cuff.until && best.id === p.cuff.car) {
      const n = npcs.get(p.cuff.n);
      if (n && !n.duel && Math.hypot(n.x - best.x, n.y - best.y) < 160) { p.cuff = null; startDuel(p, copFighter(n), best); return; }
    }
    if (best.ai) { const from = { x: ped.x, y: ped.y }; bailOut(best, from); ev(['j', p.id, 0]); p.score += 100; }
    if (best.driver) {
      const v = players.get(best.driver);
      if (v && v !== p) {
        const pair = Math.min(p.id, v.id) + ':' + Math.max(p.id, v.id);
        if (!best.jk || best.jk.pair !== pair || time - best.jk.t > 30) best.jk = { pair, n: 0, t: time };
        best.jk.n++; best.jk.t = time;
        if (best.jk.n >= S.Fight.DUEL_AT && !p.duel && !v.duel) offerFight(p, v, best); // the jack goes ahead; a fist fight is offered to both
        exitCar(v, true); ev(['j', p.id, v.id]); p.score += 100;
        for (const n of npcs.values()) if (n.owner === v.id) { n.foe = p.id; n.foeT = time + 12; } // your crew goes for whoever pulled you out
        v.ped.safeFrom = { car: best.id, until: time + 1.2 }; // thrown out beside their own car: it can't run them over
        if (v.bot) { v.want = { car: best.id, until: time + 8, after: time + 0.6 + rand() * 0.6 }; v.holdUntil = 0; } // a bot wants its car back
      }
    }
    best.driver = p.id; ped.car = best.id; ped.fire = 0; p.footSel = false; best.fadeAt = 0; best.usedT = time; best.fireAI = null;
    if (best.t === HELI) { best.hm = 1; best.exitOnLand = false; best.idleT = 0; }
    ped.x = best.x; ped.y = best.y; ped.a = best.a;
    ev(['e', p.id, best.id]);
  }


  // ------------------------------------------------------------------ traffic
  // Civilian cars drive around wherever the players are: right-hand lanes, turns at junctions, U-turns at dead
  // ends, and they brake for anything in front of them. Pull the driver out and the car is yours; shoot it up or
  // set it alight and the driver bails out and runs.
  const TRAFFIC = opts.traffic !== undefined ? opts.traffic : [7, 11, 16][map.size];
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // east, south, west, north (clockwise: d + 1 turns right)
  const DANG = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const roadT = (x, y) => S.tile(map, x, y) === T.ROAD;
  const junction = (x, y) => roadT(x, y) && map.roadCols.has(x) && map.roadRows.has(y);
  function laneOk(x, y, d) {
    if (!roadT(x, y)) return false;
    if (junction(x, y)) return true;
    if (d === 1) return map.roadCols.has(x) && map.roadCols.has(x + 1); // southbound: the west half of the road
    if (d === 3) return map.roadCols.has(x) && map.roadCols.has(x - 1); // northbound: the east half
    if (d === 0) return map.roadRows.has(y) && map.roadRows.has(y - 1); // eastbound: the south half
    return map.roadRows.has(y) && map.roadRows.has(y + 1); //              westbound: the north half
  }
  function planTraffic(c) {
    const ai = c.ai, d = ai.d, [dx, dy] = DIRS[d], x = ai.tx, y = ai.ty, nx = x + dx, ny = y + dy;
    const opt = [];
    if (junction(nx, ny)) {
      const r = (d + 1) % 4, l = (d + 3) % 4, [rx, ry] = DIRS[r], [lx, ly] = DIRS[l], mx = nx + dx, my = ny + dy;
      if (junction(mx, my) && laneOk(mx + dx, my + dy, d) && !junction(mx + dx, my + dy)) opt.push([3, [[nx, ny, d], [mx, my, d], [mx + dx, my + dy, d]]]);
      if (laneOk(nx + rx, ny + ry, r) && !junction(nx + rx, ny + ry)) opt.push([2, [[nx, ny, d], [nx + rx, ny + ry, r]]]);
      if (junction(mx, my) && junction(mx + lx, my + ly) && laneOk(mx + 2 * lx, my + 2 * ly, l) && !junction(mx + 2 * lx, my + 2 * ly)) opt.push([2, [[nx, ny, d], [mx, my, d], [mx + lx, my + ly, l], [mx + 2 * lx, my + 2 * ly, l]]]);
    } else if (laneOk(nx, ny, d)) opt.push([1, [[nx, ny, d]]]);
    if (!opt.length) {
      // dead end (a river, the harbour): swing over into the other lane and head back
      const u = (d + 2) % 4, [lx, ly] = DIRS[(d + 3) % 4];
      if (laneOk(x + lx, y + ly, u)) opt.push([1, [[x + lx, y + ly, u], [x + lx - dx, y + ly - dy, u]]]);
    }
    if (!opt.length) { ai.lost = true; return; }
    let tot = 0; for (const o of opt) tot += o[0];
    let r = rand() * tot;
    for (const o of opt) { r -= o[0]; if (r <= 0) { ai.path = o[1].slice(); return; } }
    ai.path = opt[0][1].slice();
  }
  function driveTraffic(c) {
    const ai = c.ai;
    if (!ai.path.length) planTraffic(c);
    let k = 0;
    if (!ai.path.length) { ai.k = 0; return; }
    const [tx, ty, td] = ai.path[0];
    const px = (tx + 0.5) * TILE, py = (ty + 0.5) * TILE;
    if (Math.hypot(px - c.x, py - c.y) < 30) { ai.tx = tx; ai.ty = ty; ai.d = td; ai.path.shift(); if (!ai.path.length) planTraffic(c); }
    // aim at the lane ahead: the next tile, eased towards the one after it
    const nxt = ai.path[0] || [tx, ty, td], aft = ai.path[1];
    // keep a little left of the lane's middle (towards the centre line), or well over it while passing something parked
    if (ai.swerve > 0) ai.swerve -= DT;
    const lane = (e) => { const [lx, ly] = DIRS[(e[2] + 3) % 4], o = ai.swerve > 0 ? 50 : 8; return [(e[0] + 0.5) * TILE + lx * o, (e[1] + 0.5) * TILE + ly * o]; };
    let [ax, ay] = lane(nxt);
    if (aft && Math.hypot(ax - c.x, ay - c.y) < 70) { const [bx, by] = lane(aft); ax = (ax + bx) / 2; ay = (ay + by) / 2; }
    const ca = Math.cos(c.a), sa = Math.sin(c.a), v = c.vx * ca + c.vy * sa;
    const da = S.angDiff(Math.atan2(ay - c.y, ax - c.x), c.a);
    if (v > 4 || v < -4) { if (da > 0.06) k |= K.RIGHT; else if (da < -0.06) k |= K.LEFT; }
    let want = Math.abs(da) > 0.5 ? 85 : Math.abs(da) > 0.2 ? 130 : ai.sp;
    // anything in front? slow down, stop, honk
    const C = S.CARS[c.t], look = C.len / 2 + 30 + Math.max(0, v) * 0.75;
    let block = 1e9, byPlayer = false, byParked = null;
    const ahead = (x, y, r) => {
      const dx = x - c.x, dy = y - c.y, f = dx * ca + dy * sa, side = Math.abs(-dx * sa + dy * ca);
      if (f > 0 && f < look + r && side < C.wid / 2 + r - 1) return f - r;
      return 1e9;
    };
    for (const o of cars.values()) {
      if (o === c || o.id === ai.pass || o.t === HELI || Math.abs(o.x - c.x) > 220 || Math.abs(o.y - c.y) > 220) continue;
      const b = ahead(o.x, o.y, S.CARS[o.t].wid / 2 + 2);
      if (b < block) { block = b; byParked = !o.ai && !o.driver && Math.hypot(o.vx, o.vy) < 10 ? o : null; byPlayer = false; ai.bk = o.ai ? 'traffic' : o.driver ? 'driven' : 'parked'; }
    }
    for (const q of players.values()) if (q.alive && !q.ped.car) { const b = ahead(q.ped.x, q.ped.y, 10); if (b < block) { block = b; byPlayer = true; ai.bk = 'player'; } }
    for (const n of npcs.values()) if (Math.abs(n.x - c.x) < 200 && Math.abs(n.y - c.y) < 200) { const b = ahead(n.x, n.y, 9); if (b < block) { block = b; byPlayer = false; ai.bk = 'npc'; } }
    if (block < 1e9) want = Math.min(want, Math.max(0, (block - C.len / 2 - 8) * 2.2));
    if (ai.swerve > 0 && !byPlayer && block > C.len / 2 - 2) want = Math.max(want, 45); // creep out round it
    if (want < 20 && v < 10) {
      ai.wait += DT;
      if (ai.bk !== 'traffic' && ai.wait > 1.4 && time > ai.horn) { ai.horn = time + 2.5 + rand() * 3; ev(['h', c.id]); }
      // a parked or abandoned car in the way: pull out and go round it (and round anything else that won't budge,
      // except a player: them you honk at)
      if (!byPlayer && ai.wait > (byParked ? 0.8 : 3.5)) { ai.pass = byParked ? byParked.id : 0; ai.swerve = 2.4; ai.wait = 0; }
    } else ai.wait = 0;
    if (ai.swerve <= 0) ai.pass = 0;
    if (v < want - 12) k |= K.UP;
    else if (v > want + 30 && v > 15) k |= K.DOWN;
    // stuck against something for a while (and nobody's watching): give up on this car
    if (Math.hypot(c.vx, c.vy) < 8 && !(want < 20)) ai.stuck += DT; else ai.stuck = 0;
    ai.k = k;
  }
  const nearHuman = (x, y, r) => { for (const q of players.values()) if (!q.bot && q.alive && Math.abs(q.ped.x - x) < r && Math.abs(q.ped.y - y) < r) return true; return false; };
  function bailOut(c, from) {
    // the driver jumps out and runs
    if (!c.ai) return;
    c.ai = null; c.wasTraffic = true;
    const ox = c.x - Math.sin(c.a) * (S.CARS[c.t].wid / 2 + 12), oy = c.y + Math.cos(c.a) * (S.CARS[c.t].wid / 2 + 12);
    const n = { id: nextId++, kind: 0, x: ox, y: oy, a: c.a + Math.PI / 2, hp: 30, sp: 38 + rand() * 18, mv: 1, dx: 0, dy: 0, panic: time + 8, fx: from ? from.x : c.x, fy: from ? from.y : c.y, fire: 0, kx: 0, ky: 0, idle: 0, safeFrom: { car: c.id, until: time + 1.5 } };
    S.collideCircle(map, n, 8, 0);
    npcs.set(n.id, n);
    ev(['pa', n.id, r1(n.x), r1(n.y)]);
  }
  function stepTraffic() {
    for (const c of cars.values()) if (c.ai) {
      if (c.dead || c.burn > 0) { bailOut(c); continue; }
      driveTraffic(c);
    }
    if (tick % 30 !== 7) return;
    // cars far from every player leave; traffic cars that got stuck or lost leave once nobody can see them
    for (const c of [...cars.values()]) {
      if (c.driver || c.duel) continue;
      const far = !nearHuman(c.x, c.y, 1800);
      if ((c.ai && (far || ((c.ai.stuck > 5 || c.ai.lost) && !nearAnyone(c.x, c.y, 700)))) || (c.wasTraffic && !c.ai && !nearHuman(c.x, c.y, 2400))) { cars.delete(c.id); ev(['rc', c.id]); }
    }
    let n = 0;
    for (const c of cars.values()) if (c.ai) n++;
    const hum = [...players.values()].filter((q) => !q.bot && q.alive);
    if (n >= TRAFFIC || !hum.length || state !== 'play') return;
    const p = hum[Math.floor(rand() * hum.length)].ped;
    for (let i = 0; i < 24; i++) {
      const ang = rand() * Math.PI * 2, dist = 600 + rand() * 650;
      const tx = Math.floor((p.x + Math.cos(ang) * dist) / TILE), ty = Math.floor((p.y + Math.sin(ang) * dist) / TILE);
      if (!roadT(tx, ty) || junction(tx, ty)) continue;
      let d = -1;
      for (let k = 0; k < 4; k++) if (laneOk(tx, ty, k)) { d = k; break; }
      if (d < 0) continue;
      const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
      if (nearAnyone(x, y, 520)) continue;
      const c = makeCar({ x, y, a: DANG[d] });
      if (!c) continue;
      if (c.t === 6 && rand() < 0.5) { cars.delete(c.id); continue; } // fewer buses
      c.ai = { d, tx, ty, path: [], k: 0, stuck: 0, wait: 0, horn: 0, swerve: 0, pass: 0, sp: (c.t === 6 ? 120 : 150) + rand() * 70, lost: false };
      c.vx = Math.cos(c.a) * 60; c.vy = Math.sin(c.a) * 60;
      break;
    }
  }

  // ------------------------------------------------------------------ the car fist fight
  // Two players who keep stealing the same car from each other drop everything and fight for it
  // (shared/fight.js). The winner drives off; the loser is wasted. Nobody else can touch them meanwhile.
  const duels = new Map();
  // a cop as a fighter: stands in for a player in the fight (its id is the cop's id, negated)
  function copFighter(n) { return { id: -n.id, cop: n, bot: true, alive: true, name: 'OFFICER', ped: { x: n.x, y: n.y, car: 0, fire: 0, kx: 0, ky: 0, z: 0, vz: 0, hit: null } }; }
  const fighterGone = (q) => (q.cop ? !npcs.has(q.cop.id) : !players.has(q.id) || !q.alive);
  // A fist fight is a choice: when the same two players keep stealing one car off each other, both get asked
  // (FIGHT? Y / walk away). It starts only if both say yes within 8 seconds; either can say no. Bots decide quickly.
  function offerFight(a, b, c) {
    const until = time + 8;
    a.offer = { with: b.id, car: c.id, until, ok: false, ask: time };
    b.offer = { with: a.id, car: c.id, until, ok: false, ask: time };
    ev(['fo', a.id, b.id]);
  }
  function answerFight(p, yes) {
    const o = p.offer;
    if (!o || time > o.until) { p.offer = null; return; }
    const q = players.get(o.with);
    if (!yes || !q || !q.alive || !p.alive || !q.offer || q.offer.with !== p.id) {
      p.offer = null; if (q && q.offer && q.offer.with === p.id) q.offer = null;
      ev(['fn', p.id, o.with]); return;
    }
    o.ok = true;
    ev(['fy', p.id, o.with]);
    if (q.offer.ok) {
      p.offer = q.offer = null;
      const c = cars.get(o.car);
      if (c && !c.dead && !c.duel && !p.duel && !q.duel && Math.hypot(p.ped.x - q.ped.x, p.ped.y - q.ped.y) < 900) startDuel(p, q, c);
      else ev(['fn', p.id, q.id]);
    }
  }
  function stepOffers() {
    for (const p of players.values()) {
      const o = p.offer;
      if (!o) continue;
      if (time > o.until || !p.alive || p.duel) { p.offer = null; continue; }
      if (p.bot && !o.ok && time > o.ask + 1 + (p.id % 7) * 0.15) answerFight(p, rand() < 0.65);
    }
  }
  function startDuel(a, b, c) {
    if (a.ped.car) exitCar(a, false);
    if (b.ped.car) exitCar(b, false);
    const d = S.Fight.create(nextId++);
    d.A = a; d.B = b; d.car = c.id; d.wx = c.x; d.wy = c.y; d.mem = [{}, {}];
    c.duel = d.id; c.driver = 0; c.vx = 0; c.vy = 0; c.spin = 0; c.jk = null;
    a.duel = d.id; b.duel = d.id;
    if (b.cop) { b.cop.duel = d.id; b.cop.mv = 0; }
    // the two of them square up beside the car
    const nx = -Math.sin(c.a), ny = Math.cos(c.a), off = S.CARS[c.t].wid / 2 + 26;
    a.duelAt = [c.x + nx * off - Math.cos(c.a) * 14, c.y + ny * off - Math.sin(c.a) * 14];
    b.duelAt = [c.x + nx * off + Math.cos(c.a) * 14, c.y + ny * off + Math.sin(c.a) * 14];
    for (const q of [a, b]) { q.ped.fire = 0; q.ped.kx = q.ped.ky = 0; q.ped.z = 0; q.ped.vz = 0; q.ped.hit = null; q.want = null; q.holdUntil = 0; }
    duels.set(d.id, d);
    ev(['du', d.id, a.id, b.id, r1(c.x), r1(c.y)]);
  }
  function endDuel(d, wi, forfeit) {
    duels.delete(d.id);
    const W = wi === 0 ? d.A : d.B, L = wi === 0 ? d.B : d.A;
    for (const q of [d.A, d.B]) { q.duel = 0; q.duelAt = null; if (q.cop) q.cop.duel = 0; }
    const c = cars.get(d.car);
    if (c) { c.duel = 0; c.jk = null; }
    if (forfeit) { if (W.cop || players.has(W.id)) ev(['de', d.id, W.id, L.id, 0]); }
    else {
      if (!W.cop) W.score += d.fk ? 1500 : 500;
      ev(['de', d.id, W.id, L.id, d.fk]);
      if (L.cop) { killNpc(L.cop, W.id, d.fk ? 53 : 40); addHeat(W, 30); } // you beat up a cop: they won't like that
      else if (W.cop) { if (L.alive) killPlayer(L, 0, d.fk ? 54 : 50); } // the cop wins: busted (or worse)
      else if (L.alive) killPlayer(L, W.id, d.fk ? 53 : 52);
    }
    // the winner gets the car
    if (!W.cop && W.alive && players.has(W.id) && c && !c.dead && !c.driver && state === 'play') {
      c.driver = W.id; W.ped.car = c.id; W.ped.fire = 0; W.footSel = false;
      W.ped.x = c.x; W.ped.y = c.y; W.ped.a = c.a;
      ev(['e', W.id, c.id]);
    }
  }
  function stepDuels() {
    for (const d of [...duels.values()]) {
      if (fighterGone(d.A)) { endDuel(d, 1, true); continue; }
      if (fighterGone(d.B)) { endDuel(d, 0, true); continue; }
      const kA = d.A.bot ? S.Fight.bot(d, 0, d.mem[0], rand) : d.A.dk | 0;
      const kB = d.B.bot ? S.Fight.bot(d, 1, d.mem[1], rand) : d.B.dk | 0;
      S.Fight.step(d, [kA, kB], DT);
      if (d.done) endDuel(d, d.win, false);
    }
  }
  function cancelDuels() {
    for (const d of duels.values()) { for (const q of [d.A, d.B]) { q.duel = 0; q.duelAt = null; if (q.cop) q.cop.duel = 0; } const c = cars.get(d.car); if (c) c.duel = 0; }
    duels.clear();
  }

  // ------------------------------------------------------------------ helicopters
  function streetNear(x, y) {
    // the nearest open street (road first) to come down on
    const tx0 = Math.floor(x / TILE), ty0 = Math.floor(y / TILE);
    for (let r = 0; r < 14; r++) for (const want of [T.ROAD, T.PAVE]) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (S.tile(map, tx0 + dx, ty0 + dy) === want) return [(tx0 + dx + 0.5) * TILE, (ty0 + dy + 0.5) * TILE];
    }
    return [x, y];
  }
  function stepHeliLife(c, drv) {
    // nobody at the controls in the air: it sets itself down
    if ((!drv || !drv.alive) && c.hm === 1) { c.hm = 2; c.exitOnLand = false; }
    if (c.crashAt && time >= c.crashAt && (c.hm === 1 || c.hm === 2)) { c.crashAt = 0; c.hm = 3; c.crashTo = streetNear(c.x, c.y); ev(['hc', c.id, r1(c.x), r1(c.y)]); }
    if (c.hm === 0 && c.exitOnLand && drv) { c.exitOnLand = false; exitCar(drv, false); ev(['e', drv.id, 0]); }
    if (c.hm === 4) {
      // crashed in the street: a fireball, the pilot crawls out, and the wreck is cleared away
      ev(['x', r1(c.x), r1(c.y), 110]);
      for (const o of cars.values()) if (o !== c && Math.hypot(o.x - c.x, o.y - c.y) < 90) damageCar(o, 60, c.driver);
      for (const q of players.values()) if (q.alive && !q.ped.car && Math.hypot(q.ped.x - c.x, q.ped.y - c.y) < 70) damagePed(q, 25, c.driver, 21);
      if (drv && drv.alive) { exitCar(drv, false); drv.ped.z = 0; drv.ped.kx = (rand() - 0.5) * 200; drv.ped.ky = (rand() - 0.5) * 200; ev(['e', drv.id, 0]); }
      else if (drv) drv.ped.car = 0;
      cars.delete(c.id); ev(['rc', c.id]);
      heliRespawn.push({ pad: c.pad, at: time + 60 });
      return;
    }
    // left parked somewhere other than its pad for a minute, out of sight: it goes home
    if (c.hm === 0 && !c.driver) {
      const pad = map.helipads[c.pad];
      if (Math.hypot(c.x - pad.x, c.y - pad.y) > 30 || c.cws[4] <= 0) {
        c.idleT += DT;
        if (c.idleT > 60 && !nearAnyone(c.x, c.y, 700)) { cars.delete(c.id); ev(['rc', c.id]); heliRespawn.push({ pad: c.pad, at: time + 5 }); }
      } else c.idleT = 0;
    }
  }
  function stepHeliRespawn() {
    for (let i = heliRespawn.length - 1; i >= 0; i--) {
      const r = heliRespawn[i], pad = map.helipads[r.pad];
      if (time < r.at) continue;
      if ([...cars.values()].some((c) => c.t === HELI && c.pad === r.pad)) { heliRespawn.splice(i, 1); continue; }
      if (nearAnyone(pad.x, pad.y, 120)) continue;
      spawnHeli(r.pad); heliRespawn.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ bots

  // tile BFS for bots (walkable = not building, not water)
  function walkable(tx, ty) { const t = S.tile(map, tx, ty); return t !== T.BUILD && t !== T.WATER; }
  function clearWalk(x0, y0, x1, y1) {
    // LOS with ped-width clearance, and no water on the way
    for (const o of [[-8, -8], [8, 8], [8, -8], [-8, 8]]) if (!S.los(map, x0 + o[0], y0 + o[1], x1 + o[0], y1 + o[1])) return false;
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 16);
    for (let i = 1; i <= n; i++) if (S.tileW(map, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n) === T.WATER) return false;
    return true;
  }
  function findPath(x0, y0, x1, y1) {
    const Wm = map.w, Hm = map.h;
    const sx = Math.floor(x0 / TILE), sy = Math.floor(y0 / TILE), gx = Math.floor(x1 / TILE), gy = Math.floor(y1 / TILE);
    if (!walkable(gx, gy)) return null;
    const prev = new Int32Array(Wm * Hm).fill(-1), q = new Int32Array(Wm * Hm);
    let h = 0, t = 0;
    const start = sy * Wm + sx, goal = gy * Wm + gx;
    prev[start] = start; q[t++] = start;
    while (h < t) {
      const c = q[h++];
      if (c === goal) break;
      const cx = c % Wm, cy = (c / Wm) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= Wm || ny >= Hm) continue;
        const n = ny * Wm + nx;
        if (prev[n] !== -1 || !walkable(nx, ny)) continue;
        prev[n] = c; q[t++] = n;
      }
    }
    if (prev[goal] === -1) return null;
    const path = [];
    for (let c = goal; c !== start; c = prev[c]) path.push([(c % Wm + 0.5) * TILE, (((c / Wm) | 0) + 0.5) * TILE]);
    path.reverse();
    path.push([x1, y1]);
    return path;
  }
  // Bots race: on GO they run for a car (the grid cars are right behind the line), then drive the course, following a
  // path over the street grid to the next checkpoint. Skill sets how hard they push. Out of the car, or stuck, they
  // sort themselves out; once the race is over they go back to fighting.
  const RACE_PACE = [0, 0.6, 0.72, 0.85, 0.94, 1];
  // a bot on foot heading for a car to take: the nearest empty one, or a slow bit of traffic to jack.
  // Returns false when there's nothing within reach.
  function botGetCar(b, maxD, traffic) {
    const ped = b.ped;
    let best = null, bd = maxD;
    for (const q of cars.values()) {
      if (q.dead || q.burn > 0 || q.t === HELI || q.t === BOAT || q.duel || (q.z || 0) > 2) continue;
      if (q.driver || (q.ai && !(traffic && Math.hypot(q.vx, q.vy) < 140))) continue;
      const d = Math.hypot(q.x - ped.x, q.y - ped.y);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) return false;
    const C = S.CARS[best.t];
    const d = S.angDiff(Math.atan2(best.y - ped.y, best.x - ped.x), ped.a);
    let k = 0;
    if (d > 0.1) k |= K.RIGHT; else if (d < -0.1) k |= K.LEFT;
    if (Math.abs(d) < 1.2) k |= K.UP;
    b.k = k;
    if (bd < C.len / 2 + 34 && Math.hypot(best.vx, best.vy) < 140) actEnter(b, best);
    return true;
  }
  // a bot behind the wheel heading for (gx, gy): follows a path over the streets, eases off for corners, backs out
  // when stuck. ram: once it can see the goal close by, it floors it straight at it.
  function botDrive(b, c, gx, gy, pace, ram) {
    const C = S.carStats(c), v = Math.hypot(c.vx, c.vy);
    b.rpT = (b.rpT || 0) - DT;
    if (!b.rpath || b.rpT <= 0 || Math.hypot(gx - b.rpGoal[0], gy - b.rpGoal[1]) > 128) {
      b.rpath = findPath(c.x, c.y, gx, gy); b.rpi = 0; b.rpGoal = [gx, gy]; b.rpT = ram ? 0.8 : 1.5;
    }
    let tx = gx, ty = gy, charge = false;
    const dGoal = Math.hypot(gx - c.x, gy - c.y);
    if (ram && dGoal < 380 && S.los(map, c.x, c.y, gx, gy)) charge = true;
    else if (b.rpath && b.rpi < b.rpath.length) {
      // aim for the furthest of the next few path points the car can see
      while (b.rpi < b.rpath.length && Math.hypot(b.rpath[b.rpi][0] - c.x, b.rpath[b.rpi][1] - c.y) < 70) b.rpi++;
      let j = b.rpi;
      for (let n = b.rpi + 1; n < Math.min(b.rpath.length, b.rpi + 5); n++) if (S.los(map, c.x, c.y, b.rpath[n][0], b.rpath[n][1])) j = n; else break;
      if (j < b.rpath.length) [tx, ty] = b.rpath[j];
    }
    const da = S.angDiff(Math.atan2(ty - c.y, tx - c.x), c.a), dist = Math.hypot(tx - c.x, ty - c.y);
    let k = 0;
    // stuck against something: back up, steering the other way
    if (b.rev > 0) { b.rev -= DT; return K.DOWN | (da > 0 ? K.LEFT : K.RIGHT); }
    if (v < 25 && (b.lastK & K.UP)) { b.stuckR = (b.stuckR || 0) + DT; if (b.stuckR > 0.8) { b.rev = 0.7; b.stuckR = 0; b.rpT = 0; } }
    else b.stuckR = 0;
    let steer = da;
    const top = pace * C.max, corner = Math.abs(da);
    let want = charge ? (corner > 1.4 ? 160 : top) : corner > 1.3 ? 120 : corner > 0.7 ? top * 0.45 : corner > 0.35 ? top * 0.7 : top;
    // look ahead: a wall or a car coming up in front means slow down and steer for the clearer side. Lower skill looks
    // further ahead and brakes earlier, so a rookie drives slowly but doesn't keep hitting things.
    if (!charge) {
      const care = [0, 1.6, 1.35, 1.15, 1, 0.9][BOT_SKILL];
      const reach = (C.len / 2 + 26 + v * 0.42) * care;
      const clear = (ang, d) => S.los(map, c.x, c.y, c.x + Math.cos(c.a + ang) * d, c.y + Math.sin(c.a + ang) * d);
      if (!clear(steer * 0.5, reach) && dist > 40) {
        const l = clear(-0.55, reach * 0.8), r = clear(0.55, reach * 0.8);
        if (l !== r) steer = r ? 0.5 : -0.5;
        want = Math.min(want, 70 + 60 / care);
      }
      // other cars in the way (traffic, parked cars, other racers): ease off behind them
      const ca = Math.cos(c.a), sa = Math.sin(c.a), look = (C.len / 2 + 24 + v * 0.5) * care;
      for (const q of cars.values()) {
        if (q === c || q.dead || (q.z || 0) > 8 || q.t === HELI) continue;
        const lx = (q.x - c.x) * ca + (q.y - c.y) * sa;
        if (lx < 0 || lx > look) continue;
        const ly = -(q.x - c.x) * sa + (q.y - c.y) * ca;
        if (Math.abs(ly) < 26) { want = Math.min(want, Math.max(40, Math.hypot(q.vx, q.vy) * 0.8)); steer += ly > 0 ? -0.35 : 0.35; break; }
      }
    }
    if (steer > 0.06) k |= K.RIGHT; else if (steer < -0.06) k |= K.LEFT;
    if (v < want) k |= K.UP; else if (v > want + 60) k |= K.DOWN;
    if (!charge && corner > 1.3 && v > 160 && dist < 160) k |= K.HAND;
    b.lastK = k;
    return k;
  }
  // Bots race: on GO they run for a car (the grid cars are right behind the line), then drive the course to each
  // checkpoint in turn. Skill sets how hard they push. Once the race is over they go back to fighting.
  // a bot at the wheel of a boat heading for (gx, gy): follows a path over the water, backs off when stuck
  function waterOk(tx, ty) { return !S.boatWall(map, (tx + 0.5) * TILE, (ty + 0.5) * TILE); }
  function waterPath(x0, y0, x1, y1) {
    const Wm = map.w, Hm = map.h, sx = Math.floor(x0 / TILE), sy = Math.floor(y0 / TILE), gx = Math.floor(x1 / TILE), gy = Math.floor(y1 / TILE);
    const prev = new Int32Array(Wm * Hm).fill(-1), q = new Int32Array(Wm * Hm), start = sy * Wm + sx;
    let h = 0, t = 0, goal = -1, gd = 1e9;
    prev[start] = start; q[t++] = start;
    while (h < t) {
      const c = q[h++], cx = c % Wm, cy = (c / Wm) | 0, d = Math.abs(cx - gx) + Math.abs(cy - gy);
      if (d < gd) { gd = d; goal = c; } // the goal itself, or the nearest water to it
      if (d === 0) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= Wm || ny >= Hm) continue;
        const n = ny * Wm + nx;
        if (prev[n] !== -1 || !waterOk(nx, ny)) continue;
        prev[n] = c; q[t++] = n;
      }
    }
    const path = [];
    for (let c = goal; c !== start && c >= 0; c = prev[c]) path.push([(c % Wm + 0.5) * TILE, (((c / Wm) | 0) + 0.5) * TILE]);
    path.reverse();
    if (gd === 0) path.push([x1, y1]);
    return path;
  }
  function waterLos(x0, y0, x1, y1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 12);
    for (let i = 1; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
      if (S.boatWall(map, x, y) || S.boatWall(map, x + 12, y) || S.boatWall(map, x - 12, y) || S.boatWall(map, x, y + 12) || S.boatWall(map, x, y - 12)) return false;
    }
    return true;
  }
  function botBoat(b, c, gx, gy, pace) {
    const C = S.carStats(c), v = Math.hypot(c.vx, c.vy);
    b.wpT = (b.wpT || 0) - DT;
    if (!b.wpath || b.wpT <= 0 || Math.hypot(gx - b.wpGoal[0], gy - b.wpGoal[1]) > 128) { b.wpath = waterPath(c.x, c.y, gx, gy); b.wpi = 0; b.wpGoal = [gx, gy]; b.wpT = 1.5; }
    let tx = gx, ty = gy;
    if (b.wpath.length) {
      while (b.wpi < b.wpath.length - 1 && Math.hypot(b.wpath[b.wpi][0] - c.x, b.wpath[b.wpi][1] - c.y) < 70) b.wpi++;
      let j = b.wpi;
      for (let n = b.wpi + 1; n < Math.min(b.wpath.length, b.wpi + 6); n++) if (waterLos(c.x, c.y, b.wpath[n][0], b.wpath[n][1])) j = n; else break;
      [tx, ty] = b.wpath[j];
    }
    if (b.rev > 0) { b.rev -= DT; return K.DOWN | (S.angDiff(Math.atan2(ty - c.y, tx - c.x), c.a) > 0 ? K.LEFT : K.RIGHT); }
    if (v < 25 && (b.lastK & K.UP)) { b.stuckR = (b.stuckR || 0) + DT; if (b.stuckR > 0.8) { b.rev = 0.7; b.stuckR = 0; b.wpT = 0; } }
    else b.stuckR = 0;
    const da = S.angDiff(Math.atan2(ty - c.y, tx - c.x), c.a), corner = Math.abs(da), top = pace * C.max;
    const want = corner > 1.3 ? 90 : corner > 0.7 ? top * 0.45 : corner > 0.35 ? top * 0.7 : top;
    let k = 0;
    if (da > 0.06) k |= K.RIGHT; else if (da < -0.06) k |= K.LEFT;
    if (v < want) k |= K.UP; else if (v > want + 60) k |= K.DOWN;
    b.lastK = k;
    return k;
  }
  // a bot on foot heading for an empty boat near the pit
  function botGetBoat(b, maxD) {
    const ped = b.ped;
    let best = null, bd = maxD;
    for (const q of cars.values()) {
      if (q.t !== BOAT || q.dead || q.burn > 0 || q.driver || q.duel) continue;
      const d = Math.hypot(q.x - ped.x, q.y - ped.y);
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) return false;
    const d = S.angDiff(Math.atan2(best.y - ped.y, best.x - ped.x), ped.a);
    let k = 0;
    if (d > 0.1) k |= K.RIGHT; else if (d < -0.1) k |= K.LEFT;
    if (Math.abs(d) < 1.2) k |= K.UP;
    b.k = k;
    if (bd < S.CARS[BOAT].len / 2 + 30) actEnter(b, best);
    return true;
  }
  function botRace(b) {
    const ped = b.ped, r = b.race;
    if (RACE.st === 1) { b.k = 0; return true; }
    const c = ped.car && cars.get(ped.car), cp = cps[r.next], land = map.race.land;
    // the checkpoint out at sea: drive to the landing, swap the car for a boat, and back again after
    if (cp.w && land && (!c || c.t !== BOAT)) {
      const dl = Math.hypot(ped.x - land.x, ped.y - land.y);
      if (c && c.t !== HELI && dl > 170) { b.k = botDrive(b, c, land.x, land.y, RACE_PACE[BOT_SKILL], false); return true; }
      if (c) { if (Math.hypot(c.vx, c.vy) < 60) actEnter(b); else b.k = K.DOWN; return true; }
      if (dl < 420 && botGetBoat(b, 420)) return true;
      if (dl > 600 && botGetCar(b, 900, true)) return true; // a long way off: a car first
      const d = S.angDiff(Math.atan2(land.y - ped.y, land.x - ped.x), ped.a);
      b.k = dl > 60 ? (d > 0.1 ? K.RIGHT : d < -0.1 ? K.LEFT : 0) | (Math.abs(d) < 1.2 ? K.UP : 0) : 0; // no boat left: wait for one
      return true;
    }
    if (c && c.t === BOAT) {
      if (cp.w) { b.k = botBoat(b, c, cp.x, cp.y, RACE_PACE[BOT_SKILL]); return true; }
      // back to shore at the landing, then out and into a car
      const tx = land ? land.x : c.x, ty = land ? land.y : c.y;
      if (land && Math.hypot(c.x - tx, c.y - ty) > 105) { b.k = botBoat(b, c, tx, ty, RACE_PACE[BOT_SKILL]); return true; }
      if (Math.hypot(c.vx, c.vy) < 90) actEnter(b); else b.k = K.DOWN;
      return true;
    }
    if (!c) return botGetCar(b, cp.w ? 500 : 900, !!land);
    if (c.t === HELI) { actEnter(b); return true; } // not racing in that
    const v = Math.hypot(c.vx, c.vy);
    let k = botDrive(b, c, cp.x, cp.y, RACE_PACE[BOT_SKILL], false);
    // don't flatten other racers still running for their cars at the start
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    for (const q of time < RACE.t - RACE_MAX + 8 ? players.values() : []) { // (only in the first seconds after GO)
      if (q === b || !q.alive || !q.race || q.ped.car) continue;
      const lx = (q.ped.x - c.x) * ca + (q.ped.y - c.y) * sa, ly = -(q.ped.x - c.x) * sa + (q.ped.y - c.y) * ca;
      if (lx > 0 && lx < 50 + v * 0.35 && Math.abs(ly) < 26) { k &= ~K.UP; if (v > 30) k |= K.DOWN; break; }
    }
    b.k = k;
    return true;
  }
  // Now and then a bot takes a car (an empty one, or jacks some traffic) and goes hunting: it drives at someone and
  // tries to run them down, with the car's guns, oil and mines if it has them. After half a minute or so, or once the
  // car is wrecked, it gets out and goes back to fighting on foot. Higher skill: more often, and faster.
  const HUNT_CHANCE = [0, 0.08, 0.12, 0.16, 0.2, 0.25];
  function botHunt(b) {
    const ped = b.ped;
    if (!b.hunt && !ped.car && state === 'play' && time > (b.huntCd || 0) && tick % 60 === b.id % 60) {
      b.huntCd = time + 5;
      // someone driving around nearby: very likely to grab a car and give chase
      let drv = null, dd = 750;
      for (const q of players.values()) {
        if (q === b || q.bot || !q.alive || q.duel || !q.ped.car) continue;
        const qc = cars.get(q.ped.car);
        if (!qc || qc.t === HELI) continue;
        const d = Math.hypot(qc.x - ped.x, qc.y - ped.y);
        if (d < dd) { dd = d; drv = q; }
      }
      if (drv && rand() < 0.35 + BOT_SKILL * 0.1) { b.hunt = { until: time + 35 + rand() * 20, find: time + 8, tg: drv.id }; b.huntCd = time + 1; }
      else if (rand() < HUNT_CHANCE[BOT_SKILL]) b.hunt = { until: time + 25 + rand() * 20, find: time + 8 };
    }
    if (!b.hunt) return false;
    const c = ped.car && cars.get(ped.car);
    const done = () => { b.hunt = null; b.huntCd = time + 15 + rand() * 15; b.rpath = null; if (ped.car) actEnter(b); return true; };
    if (time > b.hunt.until) return done();
    if (!c) {
      if (time > b.hunt.find) { b.hunt = null; b.huntCd = time + 10; return false; } // couldn't get one: forget it
      return botGetCar(b, 420, true) || ((b.hunt = null), false);
    }
    if (c.t === HELI || c.duel) return done();
    if (c.burn > 0 || c.hp < S.carStats(c).hp * 0.25) return done(); // bail out of a wreck
    // the target: the driver it set out to chase while they're still in reach, otherwise the nearest player it can
    // get at (people on foot first: they squash)
    let tg = null, td = 1e9;
    const lock = b.hunt.tg && players.get(b.hunt.tg);
    if (lock && lock.alive && !lock.duel && lock.invis <= 0) {
      const lq = lock.ped.car ? cars.get(lock.ped.car) : lock.ped;
      if (lq && Math.hypot(lq.x - c.x, lq.y - c.y) < 1600) { tg = lock; td = 0; }
    }
    for (const q of tg ? [] : players.values()) {
      if (q === b || !q.alive || q.duel || q.invis > 0 || (q.ped.z || 0) > 20) continue;
      const d = Math.hypot(q.ped.x - c.x, q.ped.y - c.y) * (q.ped.car ? 1.6 : 1) * (q.bot ? 1.3 : 1);
      if (d < td) { td = d; tg = q; }
    }
    if (!tg) return done();
    const tq = tg.ped.car ? cars.get(tg.ped.car) : tg.ped, tx = tq.x, ty = tq.y;
    let k = botDrive(b, c, tx, ty, RACE_PACE[BOT_SKILL], true);
    // car weapons: guns and the jump when the target is dead ahead, oil and mines when it's on our tail
    if (c.t === TANK) { const da = Math.abs(S.angDiff(Math.atan2(ty - c.y, tx - c.x), c.a)), d = Math.hypot(tx - c.x, ty - c.y); if (da < 0.08 && d < 520 && d > 90) k |= K.FIRE; }
    const w = cwSel(c);
    if (w >= 0 && time > (b.cwT || 0)) {
      const da = Math.abs(S.angDiff(Math.atan2(ty - c.y, tx - c.x), c.a)), d = Math.hypot(tx - c.x, ty - c.y);
      const ahead = da < 0.12 && d < 450, behind = da > 2.6 && d < 260;
      if (((w === 0 || w === 3) && ahead) || ((w === 1 || w === 2) && behind)) { k |= K.FIRE; if (w === 3) b.cwT = time + 2; }
    }
    b.k = k;
    return true;
  }
  function botThink(b) {
    if (!b.alive) { b.k = 0; return; }
    const ped = b.ped;
    if (b.race && (RACE.st === 1 || RACE.st === 2) && botRace(b)) return;
    if (!b.race && !b.want && botHunt(b)) return;
    if (ped.car) {
      if (b.holdUntil > time) { b.k = rand() < 0.01 ? K.UP : 0; return; } // sits in the car it just took, daring you to take it back
      actEnter(b); return;
    }
    // car envy: now and then a bot runs over and pulls a player out of a slow car (or wants its own car back)
    if (b.want && (time > b.want.until || !cars.has(b.want.car))) b.want = null;
    if (!b.want && state === 'play' && time > (b.wantCd || 0) && tick % 30 === b.id % 30) {
      b.wantCd = time + 1;
      for (const c of cars.values()) {
        if (!c.driver || c.duel || c.dead || c.t === HELI || Math.hypot(c.vx, c.vy) > 120) continue;
        const q = players.get(c.driver);
        if (!q || q.bot || q.duel || Math.hypot(c.x - ped.x, c.y - ped.y) > 300) continue;
        if (rand() < 0.15) { b.want = { car: c.id, until: time + 7 }; b.wantCd = time + 14; }
        break;
      }
    }
    if (b.want) {
      const c = cars.get(b.want.car), C = S.CARS[c.t], d = Math.hypot(c.x - ped.x, c.y - ped.y);
      if (c.duel || c.dead) { b.want = null; }
      else {
        let k = 0;
        const da = S.angDiff(Math.atan2(c.y - ped.y, c.x - ped.x), ped.a);
        if (da > 0.1) k |= K.RIGHT; else if (da < -0.1) k |= K.LEFT;
        if (Math.abs(da) < 1) k |= K.UP;
        b.k = k;
        if (d < C.len / 2 + 40 && Math.hypot(c.vx, c.vy) < 170 && c.driver !== b.id && time > (b.want.after || 0)) {
          actEnter(b);
          if (b.duel) { b.want = null; return; }
          if (ped.car === c.id) { b.want = null; b.holdUntil = time + 3 + rand() * 3; }
        }
        return;
      }
    }
    b.bt -= DT;
    if (b.bt <= 0) {
      const SK = SKILL[BOT_SKILL];
      b.bt = SK.think * (1 + rand() * 0.6);
      let best = null, bd = SK.sight;
      for (const q of players.values()) {
        if (q === b || !q.alive || q.duel || q.invis > 0 && rand() < 0.7) continue;
        const tx = q.ped.x, ty = q.ped.y, d = Math.hypot(tx - ped.x, ty - ped.y);
        if (d < bd && S.los(map, ped.x, ped.y, tx, ty)) { bd = d; best = q; }
      }
      if (best && best.id !== b.target) b.seen = 0;
      b.target = best ? best.id : 0;
      b.aimErr = (rand() - 0.5) * SK.err;
      if (best) {
        // the best weapon for the distance, but now and then whatever it fancies (and it sticks with a choice a while)
        if (time > (b.wKeep || 0)) {
          const pref = bd < 170 ? [5, 3, 4, 2, 1, 0, 6] : bd < 260 ? [3, 4, 2, 6, 7, 8, 1, 0] : [6, 2, 1, 0, 8, 7];
          const ok = (w) => b.inv[w] > 0 && (w !== 6 || bd > 110) && (w < 7 || bd > 90) && (S.WEAPONS[w].range || [0, 0, 0, 0, 0, 0, 800, 360, 360][w]) > bd * 0.9;
          const have = pref.filter(ok);
          b.w = have.length ? (rand() < 0.3 ? have[Math.floor(rand() * have.length)] : have[0]) : S.FISTS;
          b.wKeep = time + 1.5 + rand() * 2.5;
        } else if (b.w !== S.FISTS && !(b.inv[b.w] > 0)) b.wKeep = 0;
      }
      // stuck detection
      if (b.lastPos && Math.hypot(ped.x - b.lastPos[0], ped.y - b.lastPos[1]) < 3 && (b.k & K.UP)) b.stuckT += 0.2; else b.stuckT = 0;
      b.lastPos = [ped.x, ped.y];
      if (b.stuckT > 0.6) { b.turnT = 0.6; b.turnDir = rand() < 0.5 ? -1 : 1; b.wp = null; b.stuckT = 0; }
    }
    let k = 0;
    const steer = (tx, ty, dz = 0.1) => {
      const d = S.angDiff(Math.atan2(ty - ped.y, tx - ped.x), ped.a);
      if (d > dz) k |= K.RIGHT; else if (d < -dz) k |= K.LEFT;
      return d;
    };
    const tgt = b.target && players.get(b.target);
    if (b.turnT > 0) {
      b.turnT -= DT; k |= b.turnDir > 0 ? K.RIGHT : K.LEFT; k |= K.UP;
    } else if (tgt && tgt.alive) {
      b.seen += DT;
      const tx = tgt.ped.x, ty = tgt.ped.y, d = Math.hypot(tx - ped.x, ty - ped.y);
      const ad = steer(tx, ty, 0.04) + b.aimErr;
      if (d > 220) k |= K.UP; else if (d < 80) k |= K.DOWN;
      const armed = b.inv.some((n) => n > 0);
      if (!armed) { k &= ~K.DOWN; if (d > 20) k |= K.UP; }
      const wpn = S.WEAPONS[b.w] || {}, rng = armed ? (wpn.range || 500) * 0.9 : 28;
      if (Math.abs(ad) < (armed ? 0.12 : 0.6) && b.seen > SKILL[BOT_SKILL].react && d < rng) k |= K.FIRE;
    } else {
      b.repath = (b.repath || 0) - DT;
      if (!b.wp || b.repath <= 0 || Math.hypot(b.wp.x - ped.x, b.wp.y - ped.y) < 40) {
        const act = pickups.filter((pk) => pk.active && pk.k < 30);
        const foes = [...players.values()].filter((q) => q !== b && q.alive && !q.duel && q.invis <= 0).map((q) => q.ped);
        const r = rand();
        const cand = r < 0.75 && foes.length ? foes : r < 0.95 && act.length ? act : map.spawns;
        let pick = null, pd = 1e9;
        for (let i = 0; i < 6; i++) {
          const s2 = cand[Math.floor(rand() * cand.length)], d = Math.hypot(s2.x - ped.x, s2.y - ped.y);
          if (d < pd && d > 60) { pd = d; pick = { x: s2.x, y: s2.y }; }
        }
        b.wp = pick; b.repath = 2 + rand() * 1.5;
        b.path = pick ? findPath(ped.x, ped.y, pick.x, pick.y) : null; b.pi = 0;
      }
      if (b.path && b.pi < b.path.length) {
        // skip ahead while the next-next node is directly reachable
        while (b.pi + 1 < b.path.length && S.los(map, ped.x, ped.y, b.path[b.pi + 1][0], b.path[b.pi + 1][1]) && clearWalk(ped.x, ped.y, b.path[b.pi + 1][0], b.path[b.pi + 1][1])) b.pi++;
        const [nx, ny] = b.path[b.pi];
        if (Math.hypot(nx - ped.x, ny - ped.y) < 20) b.pi++;
        const d = steer(nx, ny); if (Math.abs(d) < 1.0) k |= K.UP;
      } else if (b.wp) { const d = steer(b.wp.x, b.wp.y); if (Math.abs(d) < 1.2) k |= K.UP; }
    }
    // never walk into water
    const ax = ped.x + Math.cos(ped.a) * 34, ay = ped.y + Math.sin(ped.a) * 34;
    if (S.tileW(map, ax, ay) === T.WATER) { k &= ~K.UP; k |= K.RIGHT; b.wp = null; }
    // jump out of the way of a car coming straight at you
    for (const c of cars.values()) {
      const dx = ped.x - c.x, dy = ped.y - c.y, d = Math.hypot(dx, dy), sp = Math.hypot(c.vx, c.vy);
      if (d < 140 && d > 1 && sp > 140 && (c.vx * dx + c.vy * dy) / (sp * d) > 0.85 && rand() < 0.5) { k |= K.HAND | K.UP; break; }
    }
    b.k = k;
  }


  // ------------------------------------------------------------------ pedestrians & police
  // Pedestrians stroll the pavements around the players and scatter when trouble starts.
  // Crimes raise your wanted level; up to two (clumsy) cops come after the most wanted player.
  // Stay out of their sight long enough and they lose interest.
  const npcs = new Map();
  let POLICE = opts.police !== undefined ? !!opts.police : true;
  const MAXPEDS = opts.peds !== undefined ? opts.peds : 22;
  const STAR_AT = [15, 45, 90, 150];
  let nextCopT = 0;
  const paveTiles = [];
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (S.tile(map, x, y) === T.PAVE) paveTiles.push([x, y]);
  const stars = (p) => { let n = 0; for (const t of STAR_AT) if ((p.heat || 0) >= t) n++; return n; };
  function addHeat(p, n) { if (!p || !POLICE) return; p.heat = Math.min(220, (p.heat || 0) + n); p.crimeT = time; }
  function nearAnyone(x, y, r) { for (const p of players.values()) if (p.alive && Math.hypot(p.ped.x - x, p.ped.y - y) < r) return true; return false; }
  function spawnPed() {
    const live = [...players.values()].filter((p) => p.alive), hum = live.filter((p) => !p.bot);
    const anchors = hum.length ? hum : live;
    if (!anchors.length || !paveTiles.length) return;
    const a = anchors[Math.floor(rand() * anchors.length)].ped;
    for (let i = 0; i < 14; i++) {
      const [tx, ty] = paveTiles[Math.floor(rand() * paveTiles.length)];
      const x = (tx + 0.25 + rand() * 0.5) * TILE, y = (ty + 0.25 + rand() * 0.5) * TILE;
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < 480 || d > 1100 || nearAnyone(x, y, 440)) continue;
      const n = { id: nextId++, kind: 0, x, y, a: rand() * 6.28 - 3.14, hp: 30, sp: 38 + rand() * 18, mv: 1, dx: 0, dy: 0, panic: 0, fx: 0, fy: 0, fire: 0, kx: 0, ky: 0, idle: 0 };
      npcs.set(n.id, n);
      return;
    }
  }
  function pickWay(n, panic) {
    const tx = Math.floor(n.x / TILE), ty = Math.floor(n.y / TILE), opt = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = S.tile(map, tx + dx, ty + dy);
      if (!(t === T.PAVE || t === T.GRASS || (panic && t === T.ROAD))) continue;
      let sc = rand();
      if (panic) sc = Math.hypot((tx + dx + 0.5) * TILE - n.fx, (ty + dy + 0.5) * TILE - n.fy) + rand() * 40;
      else { if (dx === n.dx && dy === n.dy) sc += 1.5; if (dx === -n.dx && dy === -n.dy) sc -= 2; }
      opt.push([sc, dx, dy]);
    }
    if (!opt.length) { n.wx = n.x + (rand() - 0.5) * 30; n.wy = n.y + (rand() - 0.5) * 30; return; }
    opt.sort((a, b) => b[0] - a[0]);
    const [, dx, dy] = opt[0];
    n.dx = dx; n.dy = dy;
    n.wx = (tx + dx + 0.25 + rand() * 0.5) * TILE; n.wy = (ty + dy + 0.25 + rand() * 0.5) * TILE;
  }
  // People on foot watch out for cars: one coming at them gets a quick sidestep out of its path (most of the time:
  // someone looking the other way still gets flattened). Cops and gang members too.
  function npcDodge(n) {
    if (n.dodgeT > time) { moveNpc(n, n.dodgeA, 165); return true; }
    for (const c of cars.values()) {
      if (c.dead || (c.z || 0) > 10 || c.t === HELI) continue;
      const sp = Math.hypot(c.vx, c.vy);
      if (sp < 60) continue;
      const dx = n.x - c.x, dy = n.y - c.y;
      if (Math.abs(dx) > 220 || Math.abs(dy) > 220) continue;
      const C = S.CARS[c.t], hx = c.vx / sp, hy = c.vy / sp;
      const ahead = dx * hx + dy * hy, side = -dx * hy + dy * hx;
      if (ahead < 0 || ahead > C.len / 2 + sp * 0.42 || Math.abs(side) > C.wid / 2 + 18) continue;
      // a coin toss per car (kept while it's coming): about half the time they see it in time
      if (n.dodgeCar !== c.id) { n.dodgeCar = c.id; n.dodgeOk = rand() < (n.kind === 0 ? 0.5 : 0.7); }
      if (!n.dodgeOk) return false;
      const s = Math.sign(side) || (rand() < 0.5 ? 1 : -1);
      n.dodgeA = Math.atan2(hx * s, -hy * s); n.dodgeT = time + 0.32;
      if (n.kind === 0) { n.panic = Math.max(n.panic, time + 1.5); n.wx = undefined; }
      moveNpc(n, n.dodgeA, 165);
      return true;
    }
    return false;
  }
  function moveNpc(n, ang, sp) {
    n.a = ang; n.mv = sp > 0 ? 1 : 0;
    n.x += Math.cos(ang) * sp * DT + n.kx * DT; n.y += Math.sin(ang) * sp * DT + n.ky * DT;
    const f = Math.exp(-6 * DT); n.kx *= f; n.ky *= f;
    S.collideCircle(map, n, 8, 0);
  }
  // gunfire, explosions and bodies make pedestrians run
  function alarm(x, y, r) {
    for (const n of npcs.values()) {
      if (n.kind !== 0 || Math.hypot(n.x - x, n.y - y) > r) continue;
      const was = n.panic > time;
      n.panic = time + 3 + rand() * 2.5; n.fx = x; n.fy = y; n.wx = undefined; n.idle = 0;
      if (!was && rand() < 0.45) ev(['pa', n.id, r1(n.x), r1(n.y)]);
    }
  }
  // cops notice shooting near them
  function noticeShot(p, x, y) {
    alarm(x, y, 300);
    if (!POLICE || !p || !players.has(p.id)) return;
    for (const n of npcs.values()) if (n.kind === 1 && Math.hypot(n.x - x, n.y - y) < 420 && S.los(map, n.x, n.y, x, y)) { addHeat(p, 1.5); break; }
  }
  function damageNpc(n, dmg, atk, cause) {
    if (n.duel) return;
    if (!npcs.has(n.id)) return;
    const a = atk ? players.get(atk) : null;
    if (n.kind === 2 && n.owner && atk === n.owner) return; // you can't hurt your own crew
    if (a && a.quad > 0) dmg *= 2;
    n.hp -= dmg;
    if (n.kind === 0) { n.panic = time + 4; n.fx = n.x - 1; n.fy = n.y; n.wx = undefined; }
    else if (n.kind === 2) { if (a) { n.foe = a.id; n.foeT = time + 12; } }
    else if (a) { addHeat(a, 6); n.target = a.id; if (n.hp > 0 && rand() < 0.35) ev(['cv', n.id, 3, r1(n.x), r1(n.y)]); }
    if (n.hp <= 0) killNpc(n, atk, cause);
  }
  function killNpc(n, atk, cause) {
    if (n.duel) return; // in a fist fight: untouchable
    if (!npcs.delete(n.id)) return;
    const k = atk ? players.get(atk) : null;
    let pts = 0;
    if (k && !(n.owner && n.owner === k.id)) { pts = n.kind === 1 ? 30 : cause === 20 ? 20 : 10; streetPoints(k, pts); addHeat(k, n.kind === 1 ? 60 : 18); }
    ev(['pk', n.id, r1(n.x), r1(n.y), r3(n.a), cause, k ? k.id : 0, n.kind, pts, n.owner || 0]);
    alarm(n.x, n.y, 260);
    if (n.kind === 1) { const c = cars.get(n.car); if (c) c.siren = false; nextCopT = time + 6; }
  }
  function stepPedestrian(n) {
    const panic = n.panic > time;
    if (!panic && n.idle > time) { n.mv = 0; return; }
    if (n.wx === undefined || Math.hypot(n.wx - n.x, n.wy - n.y) < 6) pickWay(n, panic);
    moveNpc(n, Math.atan2(n.wy - n.y, n.wx - n.x), panic ? 125 : n.sp);
    if (!panic && rand() < 0.15 * DT) n.idle = time + 1 + rand() * 2.5;
  }
  function copCount() { let c = 0; for (const n of npcs.values()) if (n.kind === 1) c++; return c; }
  function spawnCop(target) {
    const tp = target.ped;
    for (let i = 0; i < 60; i++) {
      // any open stretch of road out of sight, facing along the road
      const ang = rand() * Math.PI * 2, dist = 520 + rand() * 400;
      const tx = Math.floor((tp.x + Math.cos(ang) * dist) / TILE), ty = Math.floor((tp.y + Math.sin(ang) * dist) / TILE);
      if (S.tile(map, tx, ty) !== T.ROAD) continue;
      const vert = map.roadCols.has(tx), hor = map.roadRows.has(ty);
      if (vert === hor) continue; // skip junctions
      const sp = { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, a: vert ? (map.roadCols.has(tx + 1) ? Math.PI / 2 : -Math.PI / 2) : (map.roadRows.has(ty + 1) ? Math.PI : 0) };
      if (vert) sp.x += map.roadCols.has(tx + 1) ? -S.KERB : S.KERB; else sp.y += map.roadRows.has(ty + 1) ? -S.KERB : S.KERB;
      if (nearAnyone(sp.x, sp.y, 430)) continue;
      const C = S.CARS[8];
      const c = { id: nextId++, t: 8, col: 2, x: sp.x, y: sp.y, a: sp.a, vx: 0, vy: 0, spin: 0, oil: 0, hp: C.hp, driver: 0, drv: false, dead: false, burn: 0, removeAt: 0,
        lastAtk: 0, lastAtkT: -99, lastDriver: 0, lastDriverT: -99, cws: [0, 0, 0, 0], cwk: 0, up: 0, cop: true, siren: true, z: 0, vz: 0 };
      if (S.carHits(map, c) || [...cars.values()].some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 70)) continue;
      cars.set(c.id, c);
      const ox = c.x - Math.sin(c.a) * (C.wid / 2 + 14), oy = c.y + Math.cos(c.a) * (C.wid / 2 + 14);
      const n = { id: nextId++, kind: 1, x: ox, y: oy, a: c.a, hp: 80, sp: 112 + rand() * 14, mv: 1, target: target.id, car: c.id, cd: 1.2, see: 0,
        breath: 0, arrest: 0, path: null, pi: 0, repath: 0, fire: 0, kx: 0, ky: 0, spotted: false, giveUp: 0 };
      S.collideCircle(map, n, 8, 0);
      npcs.set(n.id, n);
      return true;
    }
    return false;
  }
  function chase(n, tx, ty, stop) {
    const d = Math.hypot(tx - n.x, ty - n.y);
    if (d < stop) { n.mv = 0; return; }
    n.repath -= DT;
    if (!n.path || n.repath <= 0) { n.path = findPath(n.x, n.y, tx, ty); n.pi = 0; n.repath = 1.3 + rand() * 0.6; }
    let wx = tx, wy = ty;
    if (n.path && n.pi < n.path.length) {
      while (n.pi + 1 < n.path.length && clearWalk(n.x, n.y, n.path[n.pi + 1][0], n.path[n.pi + 1][1])) n.pi++;
      [wx, wy] = n.path[n.pi];
      if (Math.hypot(wx - n.x, wy - n.y) < 16) n.pi++;
    }
    moveNpc(n, Math.atan2(wy - n.y, wx - n.x), n.sp);
  }
  const copShooter = (n) => ({ id: 0, copN: n });
  function stepCop(n) {
    let tgt = players.get(n.target);
    if (!tgt || !tgt.alive || !stars(tgt) || tgt.duel) {
      tgt = null;
      let bd = 1500;
      for (const p of players.values()) if (p.alive && !p.duel && stars(p) && Math.hypot(p.ped.x - n.x, p.ped.y - n.y) < bd) { bd = Math.hypot(p.ped.x - n.x, p.ped.y - n.y); tgt = p; }
      n.target = tgt ? tgt.id : 0; n.spotted = false;
    }
    const car = cars.get(n.car);
    if (car) car.siren = !!tgt;
    if (!tgt) {
      // lost interest: amble back to the car and leave once nobody's looking
      if (!n.giveUp) { n.giveUp = time; ev(['cv', n.id, 2, r1(n.x), r1(n.y)]); }
      if (car && !car.driver) chase(n, car.x, car.y, 30); else n.mv = 0;
      if (time - n.giveUp > 14 || !nearAnyone(n.x, n.y, 700)) npcs.delete(n.id);
      return;
    }
    n.giveUp = 0;
    if (n.lpT !== tick - 1) { n.lpx = undefined; n.lpy = undefined; }
    const tp = tgt.ped, dx = tp.x - n.x, dy = tp.y - n.y, d = Math.hypot(dx, dy), want = Math.atan2(dy, dx);
    // invisible: the cops can't see you (unless they walk right into you). They go to where they last saw you,
    // look around, and lose interest like any other time you get out of sight.
    const hidden = tgt.invis > 0 && d > 30;
    const sees = !hidden && d < 650 && tp.z < 20 && S.los(map, n.x, n.y, tp.x, tp.y);
    if (sees) { tgt.seenT = time; n.see += DT; n.lkx = tp.x; n.lky = tp.y; if (!n.spotted) { n.spotted = true; ev(['cv', n.id, 0, r1(n.x), r1(n.y)]); } } else n.see = 0;
    if (hidden) {
      n.arrest = 0;
      if (n.lkx !== undefined && Math.hypot(n.lkx - n.x, n.lky - n.y) > 30) chase(n, n.lkx, n.lky, 28);
      else { n.mv = 0; n.a += DT * 1.5; } // looking around
      return;
    }
    n.cd -= DT;
    // still a bit clumsy: now and then they stop to catch their breath
    if (n.breath > time) { n.mv = 0; return; }
    if (rand() < 0.12 * DT) { n.breath = time + 0.4 + rand() * 0.5; n.mv = 0; return; }
    const st = stars(tgt);
    // any wanted level: a cop who reaches your car while it's slow drags you out. Then you have two seconds:
    // run, or get back in your car and fight the cop for it. Still standing there after that: BUSTED.
    if (tp.car) {
      const c = cars.get(tp.car);
      if (c && !c.duel && c.t !== HELI && d < S.CARS[c.t].len / 2 + 28 && Math.hypot(c.vx, c.vy) < 50 && !(c.z > 0)) {
        exitCar(tgt, true); ev(['j', n.id, tgt.id]); ev(['cv', n.id, 1, r1(n.x), r1(n.y)]);
        tp.safeFrom = { car: c.id, until: time + 1.2 };
        tgt.cuff = { n: n.id, car: c.id, until: time + 2 };
        n.breath = 0; n.arrest = 0;
        return;
      }
      if (st <= 1) { chase(n, tp.x, tp.y, 20); return; }
    }
    if (tgt.cuff && tgt.cuff.n === n.id) {
      const cf = tgt.cuff;
      if (time < cf.until) { n.a = want; if (d > 24) chase(n, tp.x, tp.y, 20); else n.mv = 0; return; }
      tgt.cuff = null;
      if (d < 46) { killPlayer(tgt, 0, 50); return; } // too slow
    }
    if (st <= 1) {
      // one star: an arrest
      if (d < 22) {
        n.mv = 0; n.a = want;
        if (n.arrest === 0) ev(['cv', n.id, 1, r1(n.x), r1(n.y)]);
        n.arrest += DT;
        if (n.arrest > 1.0) { n.arrest = 0; killPlayer(tgt, 0, 50); }
        return;
      }
      n.arrest = 0;
      chase(n, tp.x, tp.y, 18);
      return;
    }
    n.arrest = 0;
    if (tgt.cuff && time < tgt.cuff.until) { n.mv = 0; return; }
    // two stars and up: they shoot. Decent shots now: they lead a moving target, but still miss a fair bit
    if (sees && d < 560) {
      const tv = tp.car ? cars.get(tp.car) : null, lead = Math.min(0.35, d / 900);
      const vx = tv ? tv.vx : (tp.x - (n.lpx ?? tp.x)) / DT, vy = tv ? tv.vy : (tp.y - (n.lpy ?? tp.y)) / DT;
      const aim = Math.atan2(tp.y + vy * lead - n.y, tp.x + vx * lead - n.x);
      n.a += Math.max(-4.5 * DT, Math.min(4.5 * DT, S.angDiff(aim, n.a)));
      if (n.see > 0.45 && n.cd <= 0 && Math.abs(S.angDiff(aim, n.a)) < 0.22) {
        n.cd = 0.7 + rand() * 0.45;
        hitscan(copShooter(n), n.x + Math.cos(n.a) * 12, n.y + Math.sin(n.a) * 12, n.a + (rand() - 0.5) * 0.3, 560, 12, 51, 0, 0);
      }
      if (d > 320) chase(n, tp.x, tp.y, 300); else n.mv = 0;
      n.lpx = tp.x; n.lpy = tp.y; n.lpT = tick;
    } else chase(n, tp.x, tp.y, 30);
  }
  // ------------------------------------------------------------------ gang members and your crew
  // Like GTA2's gang members who climb in when you pull up and sound the horn: a few gang members (green jackets,
  // red bandanas) hang around on the pavements. Stop next to them in a car and honk (H): up to as many as the car
  // has seats jump in. While they ride along they lean out and shoot at whoever's after you (other players, bots,
  // their crews, cops on your tail). Get out and they get out, follow you on foot and fight beside you; get back in
  // and they climb back in. You can't hurt them, nor they you. If you die they split up and go back to the street.
  // Leave them standing on the street, they wander off after a while. Shoot one that isn't yours and its friends
  // fight back.
  const GANG_MAX = 5, CREW_MAX = 3;
  const SEATS = [1, 1, 3, 3, 2, 2, 3, 1, 3, 0, 0, 1, 2]; // passenger seats per car type (tank: none)
  function spawnGang() {
    const live = [...players.values()].filter((p) => p.alive && !p.bot);
    if (!live.length || !paveTiles.length) return;
    const a = live[Math.floor(rand() * live.length)].ped;
    for (let i = 0; i < 14; i++) {
      const [tx, ty] = paveTiles[Math.floor(rand() * paveTiles.length)];
      const x = (tx + 0.25 + rand() * 0.5) * TILE, y = (ty + 0.25 + rand() * 0.5) * TILE;
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < 450 || d > 1100 || nearAnyone(x, y, 420)) continue;
      const n = { id: nextId++, kind: 2, x, y, a: rand() * 6.28 - 3.14, hp: 60, sp: 70 + rand() * 15, mv: 0, dx: 0, dy: 0, panic: 0, fx: 0, fy: 0, fire: 0, kx: 0, ky: 0, idle: time + rand() * 4, cd: 0, gun: rand() < 0.35 ? 2 : 0, owner: 0, foe: 0, foeT: 0 };
      npcs.set(n.id, n);
      return;
    }
  }
  const crewOf = (p) => { let n = p.ride ? p.ride.length : 0; for (const q of npcs.values()) if (q.owner === p.id) n++; return n; };
  // honking: gang members close by (and your own crew left on the street) jump in
  function recruit(p) {
    const c = cars.get(p.ped.car);
    if (!c || c.dead || c.t === HELI || c.duel || Math.hypot(c.vx, c.vy) > 90) return;
    p.ride = p.ride || [];
    const seats = SEATS[c.t] || 0;
    let n0 = crewOf(p);
    const near = [...npcs.values()].filter((n) => n.kind === 2 && !n.duel && (n.owner === p.id || (!n.owner && !(n.foe === p.id && time < n.foeT)))
      && Math.hypot(n.x - c.x, n.y - c.y) < 170 && S.los(map, n.x, n.y, c.x, c.y)).sort((u, v) => Math.hypot(u.x - c.x, u.y - c.y) - Math.hypot(v.x - c.x, v.y - c.y));
    for (const n of near) {
      if (n.owner === p.id) { n.board = time + 8; continue; } // already yours: come on, get in
      if (n0 >= Math.min(CREW_MAX, seats)) break;
      n.owner = p.id; n.board = time + 8; n.foe = 0; n0++;
      ev(['cm', n.id, p.id, n0]);
    }
  }
  // out of the car beside it, ready to fight (or just tag along)
  function dropRiders(p, c) {
    if (!p.ride || !p.ride.length) return;
    const C = S.CARS[c.t];
    p.ride.forEach((r, i) => {
      const side = i % 2 ? 1 : -1, back = (i >> 1) * 16;
      const x = c.x - Math.sin(c.a) * side * (C.wid / 2 + 12) - Math.cos(c.a) * back, y = c.y + Math.cos(c.a) * side * (C.wid / 2 + 12) - Math.sin(c.a) * back;
      const n = { id: r.id, kind: 2, x, y, a: c.a, hp: r.hp, sp: 80, mv: 0, dx: 0, dy: 0, panic: 0, fx: 0, fy: 0, fire: 0, kx: 0, ky: 0, idle: 0, cd: 0.3, gun: r.gun, owner: p.id, foe: 0, foeT: 0, safeFrom: { car: c.id, until: time + 1.5 } };
      S.collideCircle(map, n, 8, c.z || 0);
      npcs.set(n.id, n);
    });
    p.ride = [];
  }
  // who the crew shoots at: anyone after their boss (any other player, bot, crew, or a cop chasing the boss)
  function crewTarget(owner, x, y, range, foe) {
    let best = null, bd = range;
    const look = (tx, ty, o) => { const d = Math.hypot(tx - x, ty - y); if (d < bd && S.los(map, x, y, tx, ty)) { bd = d; best = o; } };
    if (foe) { const f = players.get(foe); if (f && f.alive && !f.duel && f.invis <= 0) { const fp = f.ped.car ? cars.get(f.ped.car) : f.ped; if (fp) look(fp.x, fp.y, { x: fp.x, y: fp.y, car: f.ped.car }); if (best) return best; } }
    if (!owner) return null;
    for (const q of players.values()) {
      if (q === owner || !q.alive || q.duel || q.invis > 0 || (q.race && RACE.st === 2)) continue;
      const qp = q.ped.car ? cars.get(q.ped.car) : q.ped;
      if (qp && (q.ped.z || 0) < 20) look(qp.x, qp.y, { x: qp.x, y: qp.y, car: q.ped.car });
    }
    for (const n of npcs.values()) {
      if (n.duel) continue;
      if ((n.kind === 1 && n.target === owner.id) || (n.kind === 2 && n.owner && n.owner !== owner.id)) look(n.x, n.y, { x: n.x, y: n.y });
    }
    return best;
  }
  const crewShot = (owner, n, ox, oy, a, ignoreCar) => { owner.crewing = true; hitscan(owner, ox, oy, a + (rand() - 0.5) * (owner.id ? 0.16 : 0.28), 420, n.gun === 2 ? 7 : 11, n.gun === 2 ? 2 : 0, ignoreCar, 0); owner.crewing = false; };
  function stepGang(n) {
    n.cd -= DT;
    const owner = n.owner ? players.get(n.owner) : null;
    if (n.owner && (!owner || !owner.alive)) { n.owner = 0; ev(['cl', n.id]); } // the boss is gone: back to the street
    if (n.owner && !owner.ped.car && Math.hypot(owner.ped.x - n.x, owner.ped.y - n.y) > 1400) { n.owner = 0; ev(['cl', n.id]); }
    // a fight: someone shot at them, or someone's after the boss
    const foe = n.foe && time < n.foeT ? n.foe : 0;
    const tg = (owner || foe) ? crewTarget(owner, n.x, n.y, 330, foe) : null;
    if (owner && owner.ped.car && (n.board > time || Math.hypot(owner.ped.x - n.x, owner.ped.y - n.y) < 260)) {
      // the boss is in a car: get in (if it's slow and there's a seat)
      const c = cars.get(owner.ped.car);
      if (c && !c.dead && c.t !== HELI) {
        const C = S.CARS[c.t], d = Math.hypot(c.x - n.x, c.y - n.y);
        if (d < C.len / 2 + 22 && Math.hypot(c.vx, c.vy) < 110 && (owner.ride || []).length < Math.min(CREW_MAX, SEATS[c.t] || 0)) {
          owner.ride = owner.ride || [];
          owner.ride.push({ id: n.id, hp: n.hp, gun: n.gun, cd: 0.5 + rand() * 0.5 });
          npcs.delete(n.id); ev(['cb', n.id, c.id]);
          return;
        }
        n.sp = 95; chase(n, c.x, c.y, 10);
        return;
      }
    }
    if (tg) {
      const want = Math.atan2(tg.y - n.y, tg.x - n.x), d = Math.hypot(tg.x - n.x, tg.y - n.y);
      n.a += Math.max(-6 * DT, Math.min(6 * DT, S.angDiff(want, n.a)));
      if (n.cd <= 0 && Math.abs(S.angDiff(want, n.a)) < 0.25) {
        n.cd = (n.gun === 2 ? 0.22 : n.owner ? 0.5 : 0.6) + rand() * 0.3;
        crewShot(owner || { id: 0, gangN: n }, n, n.x + Math.cos(n.a) * 12, n.y + Math.sin(n.a) * 12, n.a, 0);
      }
      if (d > 200) { n.sp = 85; chase(n, tg.x, tg.y, 180); } else n.mv = 0;
      return;
    }
    if (owner) {
      // tag along, each in its own spot behind the boss, spread out (not all in one heap)
      let i = 0; for (const q of npcs.values()) { if (q === n) break; if (q.owner === owner.id) i++; }
      const oa = owner.ped.a, bx = -30 - (i >> 1) * 6, by = (i - 1) * 24;
      const fx = owner.ped.x + Math.cos(oa) * bx - Math.sin(oa) * by, fy = owner.ped.y + Math.sin(oa) * bx + Math.cos(oa) * by;
      n.sp = Math.hypot(fx - n.x, fy - n.y) > 120 ? 110 : 85;
      chase(n, fx, fy, 10);
      if (!n.mv) n.a = oa;
      return;
    }
    // a gang member on its corner: mostly hanging about, now and then a stroll
    if (n.idle > time) { n.mv = 0; return; }
    if (n.wx === undefined || Math.hypot(n.wx - n.x, n.wy - n.y) < 6) pickWay(n, false);
    moveNpc(n, Math.atan2(n.wy - n.y, n.wx - n.x), 34);
    if (rand() < 0.4 * DT) n.idle = time + 2 + rand() * 5;
  }
  // the crew riding along: drive-by shooting out of the windows
  function stepRiders() {
    for (const p of players.values()) {
      if (!p.ride || !p.ride.length) continue;
      const c = p.alive && p.ped.car ? cars.get(p.ped.car) : null;
      if (!c) { p.ride = []; continue; }
      const C = S.CARS[c.t];
      for (const r of p.ride) {
        r.cd -= DT;
        if (r.cd > 0) continue;
        r.cd = (r.gun === 2 ? 0.25 : 0.7) + rand() * 0.4;
        const tg = crewTarget(p, c.x, c.y, 340, 0);
        if (!tg) { r.cd = 0.3; continue; }
        const a = Math.atan2(tg.y - c.y, tg.x - c.x);
        const side = Math.sign(S.angDiff(a, c.a)) || 1, ox = c.x - Math.sin(c.a) * side * (C.wid / 2 + 4), oy = c.y + Math.cos(c.a) * side * (C.wid / 2 + 4);
        crewShot(p, r, ox, oy, Math.atan2(tg.y - oy, tg.x - ox), c.id);
      }
    }
  }
  function stepNpcs() {
    let peds = 0;
    let gang = 0;
    for (const n of npcs.values()) { if (n.kind === 0) peds++; else if (n.kind === 2 && !n.owner) gang++; }
    if (peds < MAXPEDS && tick % 15 === 0) spawnPed();
    if (MAXPEDS > 0 && gang < GANG_MAX && tick % 40 === 7) spawnGang();
    for (const n of [...npcs.values()]) {
      if ((n.kind === 0 || (n.kind === 2 && !n.owner)) && !nearAnyone(n.x, n.y, 1500)) { npcs.delete(n.id); continue; }
      if (n.fire > 0) { n.fire -= DT; damageNpc(n, 26 * DT, n.fireBy, 22); if (!npcs.has(n.id)) continue; }
      if (n.duel) { n.mv = 0; continue; }
      if (npcDodge(n)) continue;
      if (n.kind === 0) stepPedestrian(n); else if (n.kind === 2) stepGang(n); else stepCop(n);
    }
    stepRiders();
    stepOffers();
    // wanted levels fade once the police have lost sight of you for long enough
    for (const p of players.values()) {
      if (!p.alive) { p.heat = 0; continue; }
      const st = stars(p);
      if (!st) { p.heat = Math.max(0, (p.heat || 0) - 3 * DT); continue; }
      const L = 6 + 3 * st, ts = time - Math.max(p.seenT || -99, p.crimeT || -99);
      if (ts > L) p.heat = Math.max(0, p.heat - 30 * DT);
    }
    if (POLICE && tick % 30 === 0 && time > nextCopT && copCount() < 2) {
      const wanted = [...players.values()].filter((p) => p.alive && stars(p) > 0).sort((a, b) => b.heat - a.heat);
      if (wanted.length && spawnCop(wanted[0])) nextCopT = time + 4;
    }
    // empty police cars are towed once nobody can see them
    if (tick % 60 === 0) for (const c of [...cars.values()]) {
      if (!c.cop || c.driver || nearAnyone(c.x, c.y, 900)) continue;
      if ([...npcs.values()].some((n) => n.car === c.id)) continue;
      cars.delete(c.id); ev(['rc', c.id]);
    }
  }
  function interest(p) {
    const st = stars(p);
    if (!st) return 0;
    const L = 6 + 3 * st, ts = time - Math.max(p.seenT || -99, p.crimeT || -99);
    return Math.max(0, Math.min(1, 1 - ts / L));
  }

  // ------------------------------------------------------------------ simulation step
  function step() {
    time += DT; tick++;
    if (state === 'over' && time >= overUntil) newMatch();
    if (state === 'play' && time >= matchEnd) endMatch();
    const frozen = state !== 'play';

    for (const p of players.values()) {
      if (p.bot && !p.duel) botThink(p);
      let k = p.k;
      if (!p.bot && p.q.length) {
        let btn = 0;
        if (p.q.length > QMAX) {
          // drop a backlog to keep lag down, but never lose a button tap (a punch, a jump) in it
          for (const i of p.q.splice(0, p.q.length - QKEEP)) btn |= i.k & (K.FIRE | K.HAND);
          p.guessed = 0;
        }
        // ticks already played on a guess while this player's keys were on their way: skip as many
        while (p.guessed > 0 && p.q.length > 1) { const d = p.q.shift(); btn |= d.k & (K.FIRE | K.HAND); p.lastSeq = d.s; p.guessed--; }
        const i = p.q.shift(); k = i.k | btn; p.k = i.k; p.lastSeq = i.s;
      } else if (!p.bot && p.lastSeq > 0 && !frozen) {
        p.guessed = Math.min(60, (p.guessed || 0) + 1); // no keys yet: keep doing what they were doing
      }
      if (frozen) k = 0;
      if (RACE.st === 1 && p.raceGrid && p.alive && !p.ped.car) { k = 0; p.ped.x = p.raceGrid[0]; p.ped.y = p.raceGrid[1]; } // on the line till GO
      if (RACE.st !== 1 && p.raceGrid) p.raceGrid = null;
      if (p.duel) {
        p.dk = k; p.curK = 0; p.k = p.bot ? 0 : p.k;
        if (p.alive && p.duelAt) { const ped = p.ped; ped.x = p.duelAt[0]; ped.y = p.duelAt[1]; ped.mv = 0; ped.fire = 0; ped.kx = ped.ky = 0; }
        continue;
      }
      p.curK = k;
      if (!p.alive) { if (time >= p.respawnAt && !frozen) spawnPlayer(p); continue; }
      const ped = p.ped;
      if (!ped.car) {
        const vz0 = ped.vz;
        S.stepPed(map, ped, k, DT);
        if (ped.hit) {
          if (ped.vz > 0 || ped.z > 1) ped.hit = null; // jumped in time
          else if (time >= ped.hit.t) { const h = ped.hit; ped.hit = null; killPlayer(p, h.killer, h.cause || 20); continue; }
        }
        if (vz0 <= 0 && ped.vz > S.PED.jump + 50) ev(['tb', r1(ped.x), r1(ped.y), p.id]); // off a trampoline
        if (vz0 < -430 && ped.vz >= 0) { if (ped.tr) ped.tr = 0; else damagePed(p, (-vz0 - 430) * 0.3, p.lastAtk && time - p.lastAtkT < 4 ? p.lastAtk : 0, 25); } // no fall damage coming down from a trampoline bounce
        else if (vz0 < 0 && ped.vz >= 0 && ped.z < 1) ped.tr = 0;
      }
      p.cd -= DT;
      const heldPunch = p.w === S.FISTS && !ped.car && p.prevFire && time - (p.lastPunch || -9) < 0.6;
      // the pistol is one shot per press: a press fires as soon as the gun is ready (a press up to 0.35 s early still
      // counts), holding it down fires nothing more. Bots keep their finger on it.
      const semi = p.w === 0 && !ped.car && !p.bot;
      if (k & K.FIRE && !p.prevFire) p.semiAt = time;
      const pull = semi ? time - (p.semiAt ?? -9) < 0.35 : k & K.FIRE;
      if (pull && p.cd <= 0 && !heldPunch) { fire(p); if (semi) p.semiAt = -9; }
      p.prevFire = !!(k & K.FIRE);
      if (p.quad > 0) p.quad -= DT;
      if (p.invis > 0) p.invis -= DT;
      if (ped.fire > 0) {
        ped.fire -= DT;
        if (!ped.car) damagePed(p, 28 * DT, p.fireBy, 22); else ped.fire = 0;
      }
      if (p.alive && !ped.car && ped.z <= 0.5 && S.deepWater(map, ped.x, ped.y)) { ev(['w', r1(ped.x), r1(ped.y)]); killPlayer(p, 0, 23); }
    }

    if (!frozen) stepDuels();
    if (!frozen) stepRace();
    stepTraffic();
    if (tick % 30 === 3) stepHeliRespawn();
    if (tick % 30 === 9) stepHomeRespawn();
    stepFireTrucks();

    for (const c of [...cars.values()]) {
      const drv = c.driver ? players.get(c.driver) : null;
      c.drv = !!(drv && drv.alive);
      if (c.ai || c.fireAI) c.drv = true;
      const grounded = !S.carAir(map, c);
      const imp = S.stepCar(map, c, drv ? drv.curK : c.ai ? c.ai.k : c.fireAI ? c.fireAI.k : 0, DT);
      if (grounded && c.vz > 0 && c.t !== HELI) ev(['cj', c.id, r1(c.x), r1(c.y)]); // off a ramp
      if (c.t === HELI) { stepHeliLife(c, drv); if (!cars.has(c.id)) continue; }
      if (imp > 160) damageCar(c, (imp - 160) * 0.1, 0);
      if (drv && drv.alive) { drv.ped.x = c.x; drv.ped.y = c.y; drv.ped.a = c.a; }
      if (c.burn > 0) { c.burn -= DT; if (c.burn <= 0) explodeCar(c); }
      if (S.deepWater(map, c.x, c.y) && !(c.z > 0) && c.t !== HELI && c.t !== BOAT) {
        ev(['w', r1(c.x), r1(c.y)]);
        if (c.driver) { const d = players.get(c.driver); c.driver = 0; if (d) { d.ped.car = 0; killPlayer(d, c.lastAtk && time - c.lastAtkT < 6 ? c.lastAtk : 0, 23); } }
        removeCar(c);
        continue;
      }
      if (drv && drv.alive && !drv.bot && !c.dead && c.burn <= 0 && c.t !== HELI && !c.duel) chopShop(c, drv);
      if (c.dead && time > c.removeAt) removeCar(c);
      else if (c.fadeAt && time >= c.fadeAt + ABANDON_FADE) dropAbandoned(c);
    }
    if (tick % 30 === 7) sweepAbandoned();
    for (const q of players.values()) if (q.ped) recPos(q, q.ped.x, q.ped.y, q.ped.z || 0);
    for (const n of npcs.values()) recPos(n, n.x, n.y, 0);
    for (const c of cars.values()) {
      if (!c.hist) c.hist = new Float64Array(HIST * 7);
      const o = (tick % HIST) * 7, h = c.hist;
      h[o] = tick; h[o + 1] = c.x; h[o + 2] = c.y; h[o + 3] = c.a; h[o + 4] = c.vx; h[o + 5] = c.vy; h[o + 6] = c.z || 0;
    }
    if (carRespawnQueue > 0 && tick % 120 === 0) {
      const s = map.carSpots[Math.floor(rand() * map.carSpots.length)];
      let visible = false;
      for (const p of players.values()) if (p.alive && Math.hypot(p.ped.x - s.x, p.ped.y - s.y) < 700) visible = true;
      if (!visible && makeCar(s)) carRespawnQueue--;
    }

    stepNpcs();
    collide();
    stepProjectiles();
    stepHazards();
    stepPickups();
    if (tick % 2 === 0) sendSnaps();
  }

  function collide() {
    const cl = [...cars.values()];
    // car vs car: oriented boxes, pushed fully apart so they can never pass through each other
    const reach = Math.max(...S.CARS.map((C) => C.len)) + 2; // no two cars further apart than this along x can touch
    for (let it = 0; it < 3; it++) {
      cl.sort((a, b) => a.x - b.x); // sweep along x: only near neighbours get the full test
      for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length && cl[j].x - cl[i].x <= reach; j++) {
        const A = cl[i], B = cl[j];
        if (A.t === HELI || B.t === HELI || Math.abs(A.y - B.y) > reach || !cars.has(A.id) || !cars.has(B.id)) continue;
        // a jumping car sails over one lower down (once it's above its roof)
        const za = A.z || 0, zb = B.z || 0;
        // ...and coming down onto its roof nearly wrecks it (it still drives) and bounces you off
        if (Math.abs(za - zb) > 4) {
          const top = za > zb ? A : B, bot = top === A ? B : A, hb = S.CARS[bot.t].h, dz = (top.z || 0) - (bot.z || 0);
          if (top.vz < 0 && dz < hb + 6 && dz > hb - 12 && S.boxOverlap(S.carBox(A), S.carBox(B))) {
            const sb = S.carStats(bot);
            if (bot.hp > sb.hp * 0.12) { bot.hp = Math.max(1, sb.hp * 0.12); bot.lastAtk = top.driver || bot.lastAtk; bot.lastAtkT = time; }
            top.hp -= S.carStats(top).hp * 0.08;
            top.vz = 230; top.z = bot.z + hb;
            ev(['cr', bot.id, r1(bot.x), r1(bot.y), top.driver || 0]);
            continue;
          }
        }
        if ((za > zb && za - zb > S.CARS[B.t].h - 4) || (zb > za && zb - za > S.CARS[A.t].h - 4)) continue;
        const CA = S.carStats(A), CB = S.carStats(B), lim = (CA.len + CB.len) / 2 + 2;
        if (Math.abs(A.x - B.x) > lim || Math.abs(A.y - B.y) > lim) continue;
        const h = S.boxOverlap(S.carBox(A), S.carBox(B));
        if (!h) continue;
        const { nx, ny, depth } = h, ma = CA.mass, mb = CB.mass, im = 1 / ma + 1 / mb;
        const da = (depth + 0.05) * (1 / ma) / im, db = (depth + 0.05) * (1 / mb) / im;
        A.x -= nx * da; A.y -= ny * da; B.x += nx * db; B.y += ny * db;
        // never push a car into a wall: the other one takes the whole push instead
        if (S.carHits(map, A)) { A.x += nx * da; A.y += ny * da; B.x += nx * da; B.y += ny * da; if (S.carHits(map, B)) { B.x -= nx * da; B.y -= ny * da; } }
        else if (S.carHits(map, B)) { B.x -= nx * db; B.y -= ny * db; A.x -= nx * db; A.y -= ny * db; if (S.carHits(map, A)) { A.x += nx * db; A.y += ny * db; } }
        if (it) continue;
        const vrel = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
        if (vrel >= 0) continue;
        const jj = (-(1 + 0.25) * vrel) / im;
        A.vx -= (jj * nx) / ma; A.vy -= (jj * ny) / ma; B.vx += (jj * nx) / mb; B.vy += (jj * ny) / mb;
        // a glancing blow spins the cars
        const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2;
        A.spin -= ((cx - A.x) * -ny - (cy - A.y) * -nx) * jj / (ma * 2200);
        B.spin -= ((cx - B.x) * ny - (cy - B.y) * nx) * jj / (mb * 2200);
        const imp = -vrel;
        if (imp > 70) {
          // the lighter car takes more of the damage
          const dmg = (imp - 70) * 0.15;
          damageCar(A, dmg * (mb / (ma + mb)) * 2, B.driver || 0);
          damageCar(B, dmg * (ma / (ma + mb)) * 2, A.driver || 0);
          // the tank crushes whatever it rams
          if (A.t === TANK && B.t !== TANK) damageCar(B, S.carStats(B).hp * 0.35, A.driver || 0);
          if (B.t === TANK && A.t !== TANK) damageCar(A, S.carStats(A).hp * 0.35, B.driver || 0);
        }
        if (imp > 90) ev(['b', r1(cx), r1(cy), Math.round(imp)]);
      }
    }
    // car vs ped
    const peds = [...players.values()].filter((p) => p.alive && !p.ped.car && !p.duel);
    for (const q of peds) {
      const ped = q.ped;
      let gz = 0, roof = null;
      // judge them against the cars where their screen showed them (not for a car they're driving into themselves)
      const back = q.bot ? 0 : Math.min(HIST - 2, Math.round((q.view || 0) / DT));
      for (const c of cl) {
        if (!cars.has(c.id) || c.t === HELI) continue;
        const P = carAsSeen(c, c.driver === q.id ? 0 : back);
        const dz = (ped.z || 0) - (P.z || 0); // the car can be up on a roof, or you can
        if (dz < -14) continue; // a jumping car goes right over you
        if (ped.safeFrom && ped.safeFrom.car === c.id && time < ped.safeFrom.until) continue;
        const C = S.CARS[c.t], dx = ped.x - P.x, dy = ped.y - P.y;
        if (Math.abs(dx) > C.len / 2 + 14 || Math.abs(dy) > C.len / 2 + 14) continue;
        const ca = Math.cos(P.a), sa = Math.sin(P.a);
        const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca, ex = C.len / 2 + 8, ey = C.wid / 2 + 8;
        // high enough to clear the roof: no collision, and you can land on it
        if (dz >= C.h - 6) {
          if (Math.abs(lx) < C.len / 2 + 2 && Math.abs(ly) < C.wid / 2 + 2 && (P.z || 0) + C.h > gz) { gz = (P.z || 0) + C.h; roof = c; }
          continue;
        }
        if (Math.abs(lx) >= ex || Math.abs(ly) >= ey) continue;
        const sp = Math.hypot(P.vx, P.vy);
        const towards = (P.vx * -dx + P.vy * -dy) < 0;
        const killer = c.driver || (c.lastDriver && time - c.lastDriverT < 3 ? c.lastDriver : 0);
        const rc = !killer && c.ai ? 26 : 20; // hit by traffic: nobody's frag
        if (sp > 110 && towards && !(killer === q.id && time - c.lastDriverT < 1.5)) {
          if (ped.vz > 0 || dz > 1) { ped.z = Math.max(ped.z, (P.z || 0) + C.h - 5); ped.vz = Math.max(ped.vz, 160); ped.hit = null; continue; } // vault over it
          if (q.bot || (ped.hit && time >= ped.hit.t)) { killPlayer(q, killer, rc); c.vx *= 0.93; c.vy *= 0.93; break; }
          // the cars are already rewound to what they saw; a short grace covers keys still in flight
          if (!ped.hit) ped.hit = { killer, t: time + (back ? 0.12 : 0.2), cause: rc };
        }
        let nlx = lx, nly = ly;
        if (ex - Math.abs(lx) < ey - Math.abs(ly)) nlx = Math.sign(lx || 1) * ex; else nly = Math.sign(ly || 1) * ey;
        ped.x = P.x + nlx * ca - nly * sa; ped.y = P.y + nlx * sa + nly * ca;
        S.collideCircle(map, ped, S.PED.r, ped.z || 0);
      }
      if (!q.alive) continue;
      ped.gz = gz;
      // standing on a roof: ride along with the car
      if (roof && ped.z <= gz + 0.5) { ped.x += roof.vx * DT; ped.y += roof.vy * DT; S.collideCircle(map, ped, S.PED.r, ped.z || 0); }
    }
    // cars vs pedestrians and cops: anything faster than a crawl is a splat
    for (const n of [...npcs.values()]) {
      if (n.duel) continue;
      for (const c of cl) {
        if (!cars.has(c.id) || c.z > 10 || c.t === HELI) continue;
        if (n.safeFrom && n.safeFrom.car === c.id && time < n.safeFrom.until) continue;
        const C = S.CARS[c.t], dx = n.x - c.x, dy = n.y - c.y;
        if (Math.abs(dx) > C.len / 2 + 12 || Math.abs(dy) > C.len / 2 + 12) continue;
        const ca = Math.cos(c.a), sa = Math.sin(c.a);
        const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca, ex = C.len / 2 + 4, ey = C.wid / 2 + 4;
        if (Math.abs(lx) >= ex || Math.abs(ly) >= ey) continue;
        if (Math.hypot(c.vx, c.vy) > 95 && !(n.owner && n.owner === c.driver)) { // a crawling car just shoves you aside
          const killer = c.driver || (c.lastDriver && time - c.lastDriverT < 3 ? c.lastDriver : 0);
          killNpc(n, killer, 20); c.vx *= 0.97; c.vy *= 0.97;
          break;
        }
        let nlx = lx, nly = ly;
        if (ex - Math.abs(lx) < ey - Math.abs(ly)) nlx = Math.sign(lx || 1) * ex; else nly = Math.sign(ly || 1) * ey;
        n.x = c.x + nlx * ca - nly * sa; n.y = c.y + nlx * sa + nly * ca;
        S.collideCircle(map, n, 8, 0);
      }
    }
    for (const n of npcs.values()) for (const q of peds) {
      if (!q.alive || q.ped.z > 16) continue;
      const dx = n.x - q.ped.x, dy = n.y - q.ped.y, d = Math.hypot(dx, dy);
      if (d < 17 && d > 1e-6) { n.x += (dx / d) * (17 - d); n.y += (dy / d) * (17 - d); S.collideCircle(map, n, 8, 0); }
    }
    // ped vs ped
    for (let i = 0; i < peds.length; i++) for (let j = i + 1; j < peds.length; j++) {
      const a = peds[i].ped, b = peds[j].ped;
      if (!peds[i].alive || !peds[j].alive || Math.abs(a.z - b.z) > 16) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d < 18 && d > 1e-6) { const p = (18 - d) / 2; a.x -= (dx / d) * p; a.y -= (dy / d) * p; b.x += (dx / d) * p; b.y += (dy / d) * p; }
    }
  }

  function projHit(pr) {
    for (const q of players.values()) {
      if (!q.alive || q.ped.car) continue;
      if (q.id === pr.owner && time - pr.born < 0.25) continue;
      if (Math.abs(q.ped.z - (pr.z || 0)) > 20) continue;
      if (Math.hypot(q.ped.x - pr.x, q.ped.y - pr.y) < 13) return true;
    }
    if ((pr.z || 0) <= 20) for (const n of npcs.values()) if (Math.hypot(n.x - pr.x, n.y - pr.y) < 12) return true;
    for (const c of cars.values()) {
      if (c.driver === pr.owner || (pr.z || 0) > 20) continue;
      const C = S.CARS[c.t], dx = pr.x - c.x, dy = pr.y - c.y, ca = Math.cos(c.a), sa = Math.sin(c.a);
      if (Math.abs(dx * ca + dy * sa) < C.len / 2 + 3 && Math.abs(-dx * sa + dy * ca) < C.wid / 2 + 3) return true;
    }
    return false;
  }
  // A rocket fired at a helicopter in the air brings it down. The game is seen from above, so a flying helicopter is
  // drawn bigger and pushed out from the middle of the screen; the rocket counts as a hit when it passes near where
  // the shooter sees the helicopter (their camera follows them), or under the helicopter itself.
  const HELI_HIT = 44;
  function rocketHeli(pr) {
    const sh = players.get(pr.owner), camX = sh ? sh.ped.x : pr.x, camY = sh ? sh.ped.y : pr.y;
    for (const c of cars.values()) {
      if (c.t !== HELI || c.dead || !(c.hm >= 1 && c.hm <= 2) || (c.z || 0) < 30 || c.driver === pr.owner) continue;
      const f = 560 / (560 - Math.min(400, c.z)); // the client's camera: cam.h 560
      const ax = camX + (c.x - camX) * f, ay = camY + (c.y - camY) * f;
      if (Math.hypot(pr.x - ax, pr.y - ay) < HELI_HIT * f || Math.hypot(pr.x - c.x, pr.y - c.y) < HELI_HIT) { shootDownHeli(c, pr.owner); return true; }
    }
    return false;
  }
  function shootDownHeli(c, atk) {
    ev(['x', r1(c.x), r1(c.y), 120, r1(c.z)]);
    const d = c.driver && players.get(c.driver);
    c.lastAtk = atk; c.lastAtkT = time;
    if (d) { c.driver = 0; d.ped.car = 0; d.ped.x = c.x; d.ped.y = c.y; killPlayer(d, atk, 24); }
    c.hm = 3; c.crashAt = 0; c.crashTo = streetNear(c.x, c.y); c.cws = [0, 0, 0, 0, 0];
    ev(['hc', c.id, r1(c.x), r1(c.y)]);
  }
  function stepProjectiles() {
    const keep = [];
    for (const pr of projs) {
      pr.life -= DT;
      let boom = pr.life <= 0;
      if (pr.k === 1 || pr.k === 3) {
        for (let s = 0; s < 2 && !boom; s++) {
          const nx = pr.x + (pr.vx * DT) / 2, ny = pr.y + (pr.vy * DT) / 2;
          if (pr.vz) { pr.z += (pr.vz * DT) / 2; if (pr.z <= 0) { pr.z = 0; boom = true; } } // a helicopter missile coming down
          if (S.heightAt(map, nx, ny) > (pr.z || 0) + 8) { boom = true; break; }
          pr.x = nx; pr.y = ny;
          if (pr.k === 1 && rocketHeli(pr)) { boom = true; pr.heli = true; break; }
          if (projHit(pr)) boom = true;
        }
        if (boom) {
          if (pr.heli) { /* went up into a helicopter: rocketHeli did the damage */ }
          else if (pr.k === 1) explosion(pr.x, pr.y, 115, 160, pr.owner, 0, 1, pr.z || 0);
          else {
            ev(['m', r1(pr.x), r1(pr.y)]);
            for (let i = 0; i < 7; i++) {
              const a = rand() * Math.PI * 2, d = rand() * 46, fx = pr.x + Math.cos(a) * d, fy = pr.y + Math.sin(a) * d;
              if (!S.solid(map, fx, fy)) hazards.push({ id: nextId++, k: 4, x: fx, y: fy, life: 3.5 + rand() * 2, owner: pr.owner });
            }
          }
          continue;
        }
      } else if (pr.k === 2) {
        const f = Math.exp(-1.7 * DT); pr.vx *= f; pr.vy *= f;
        const hit = () => S.heightAt(map, pr.x, pr.y) > (pr.z || 0) + 8;
        pr.x += pr.vx * DT; if (hit()) { pr.x -= pr.vx * DT; pr.vx *= -0.5; }
        pr.y += pr.vy * DT; if (hit()) { pr.y -= pr.vy * DT; pr.vy *= -0.5; }
        if (boom) { explosion(pr.x, pr.y, 110, 145, pr.owner, 0, 1, pr.z || 0); continue; }
      }
      keep.push(pr);
    }
    projs = keep;
  }
  function stepHazards() {
    const keep = [];
    for (const h of hazards) {
      h.life -= DT;
      if (h.life <= 0) continue;
      if (h.k === 4) {
        for (const q of players.values()) {
          if (!q.alive || q.ped.car) continue;
          if (Math.hypot(q.ped.x - h.x, q.ped.y - h.y) < 20) { q.ped.fire = Math.max(q.ped.fire, 2.5); q.fireBy = h.owner; }
        }
        for (const n of npcs.values()) if (Math.hypot(n.x - h.x, n.y - h.y) < 20) { n.fire = Math.max(n.fire, 2.5); n.fireBy = h.owner; }
        if (tick % 6 === 0) for (const c of cars.values()) if (Math.hypot(c.x - h.x, c.y - h.y) < 28) damageCar(c, 1.6, h.owner);
      } else if (h.k === 5) {
        for (const c of cars.values()) {
          if (Math.hypot(c.x - h.x, c.y - h.y) < 26 && !(c.z > 2)) {
            if (c.oil <= 0 && Math.hypot(c.vx, c.vy) > 80) c.spin += (rand() < 0.5 ? -1 : 1) * (3 + rand() * 3);
            c.oil = 1.4;
            if (c.driver !== h.owner) { c.lastAtk = h.owner; c.lastAtkT = time; }
          }
        }
      } else if (h.k === 6) {
        if (time > h.arm) {
          let trig = false;
          for (const c of cars.values()) if (!c.dead && !(c.z > 2) && Math.hypot(c.x - h.x, c.y - h.y) < 30) trig = true;
          for (const q of players.values()) if (q.alive && !q.ped.car && Math.hypot(q.ped.x - h.x, q.ped.y - h.y) < 18) trig = true;
          if (trig) { explosion(h.x, h.y, 110, 160, h.owner, 0); continue; }
        }
      }
      keep.push(h);
    }
    hazards = keep;
  }
  function stepPickups() {
    for (const pk of pickups) {
      if (!pk.active) { if (time >= pk.at) pk.active = true; continue; }
      for (const p of players.values()) {
        if (!p.alive || p.duel) continue;
        const ped = p.ped, inCar = !!ped.car;
        if (pk.k >= 30 && !inCar) continue; // car weapons need a car; every other crate can be grabbed on foot or driving
        if (inCar) { const hc = cars.get(ped.car); if (hc && hc.t === HELI) continue; }
        if (Math.hypot(ped.x - pk.x, ped.y - pk.y) > (inCar ? 40 : 24)) continue;
        const k = pk.k;
        if (k < 20) {
          // keep the weapon you're holding; only arm yourself if you were down to your fists (bots grab upgrades)
          const empty = p.w === S.FISTS || p.inv[p.w] <= 0;
          p.inv[k] = Math.min(999, p.inv[k] + S.WEAPONS[k].pick);
          if (empty || (p.bot && p.w === 0)) p.w = k;
        }
        else if (k === 20) { if (ped.hp >= 100) continue; ped.hp = 100; ped.fire = 0; }
        else if (k === 21) { if (ped.ar >= 100) continue; ped.ar = 100; }
        else if (k === 22) p.quad = 20;
        else if (k === 23) p.invis = 20;
        else {
          const c = cars.get(ped.car);
          if (!c) continue;
          const ck = k - 30;
          const had = cwSel(c) >= 0;
          c.cws[ck] = Math.min(999, c.cws[ck] + S.CARWEAPONS[ck].pick);
          if (!had) { c.cwk = ck; p.footSel = false; } // only select it if the car had nothing loaded
        }
        pk.active = false; pk.at = time + (k === 22 || k === 23 ? 45 : 20);
        ev(['p', p.id, k]);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ match flow
  function endMatch() {
    if (state !== 'play') return;
    let best = null;
    for (const p of players.values()) if (!best || p.frags > best.frags) best = p;
    winner = best ? best.id : 0; state = 'over'; overUntil = time + 10;
    cancelDuels();
    ev(['o', winner]);
  }
  let lastRestart = -99;
  // ------------------------------------------------------------------ race mode
  // One race-start pickup per city. Touch it and everyone races: 3 laps through the checkpoints in order, the first
  // one is the start/finish line. First home gets the chequered flag and a champagne shower, then it's back to normal.
  const RACE = { st: 0, t: 0, win: 0, by: 0, laps: 2 }; // st: 0 pickup waiting, 1 countdown, 2 racing, 3 finished, 4 pickup coming back
  const RACE_R = 95, RACE_MAX = 420, RACE_BACK = 45;
  const cps = map.race.cps;
  function raceReset() { RACE.st = 0; RACE.t = 0; RACE.win = 0; RACE.by = 0; for (const p of players.values()) p.race = null; }
  function racePos(p) { return p.alive && p.ped && !p.duel ? p.ped : null; }
  // Everyone in the race starts on foot on the start line, held there through the countdown, with a grid of fast
  // cars parked just behind them: on GO it's a sprint to the cars.
  function raceLineUp() {
    const c0 = cps[0], c1 = cps[1] || cps[0];
    const vert = c0.v === 1, sg = Math.sign(vert ? c1.y - c0.y : c1.x - c0.x) || 1;
    const fx = vert ? 0 : sg, fy = vert ? sg : 0, ax = vert ? 1 : 0, ay = vert ? 0 : 1; // forward, across the road
    const at = (across, back) => ({ x: c0.x + ax * across - fx * back, y: c0.y + ay * across - fy * back });
    const racers = [...players.values()].filter((r) => r.race && r.alive);
    // clear the start: traffic and empty cars off the grid
    for (const c of [...cars.values()]) {
      if (c.driver || c.t === HELI) continue;
      const lx = (c.x - c0.x) * ax + (c.y - c0.y) * ay, lb = -((c.x - c0.x) * fx + (c.y - c0.y) * fy);
      if (Math.abs(lx) < 90 && lb > -120 && lb < 160 + racers.length * 40) removeCar(c);
    }
    racers.forEach((r, i) => {
      if (r.ped.car) exitCar(r, false);
      r.cuff = null;
      const q = at(((i % 4) - 1.5) * 28, 22 + Math.floor(i / 4) * 26), ped = r.ped;
      Object.assign(ped, { x: q.x, y: q.y, z: 0, vz: 0, gz: 0, kx: 0, ky: 0, jvx: 0, jvy: 0, a: Math.atan2(fy, fx), fire: 0, hit: null });
      r.raceGrid = [q.x, q.y];
      // a car for each racer, two abreast behind the line
      const cq = at((i % 2 ? 1 : -1) * 32, 100 + Math.floor(i / 2) * 70);
      const t = [1, 7, 0][i % 3]; // speedster, bruiser, coupe
      const c = {
        id: nextId++, t, col: Math.floor(rand() * S.CAR_COLORS.length), x: cq.x, y: cq.y, a: Math.atan2(fy, fx), vx: 0, vy: 0, spin: 0, oil: 0, hp: S.CARS[t].hp,
        driver: 0, drv: false, dead: false, burn: 0, removeAt: 0, lastAtk: 0, lastAtkT: -99, lastDriver: 0, lastDriverT: -99, cws: [0, 0, 0, 0], cwk: 0, up: 0, z: 0, vz: 0,
      };
      if (!S.carHits(map, c)) cars.set(c.id, c);
    });
    // and a speedboat for each racer at the pit, for the checkpoint out at sea
    racers.forEach((r, i) => {
      const s = map.race.pit[i];
      if (!s || [...cars.values()].some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 50)) return;
      const c = special(BOAT, s.x, s.y, s.a, { col: i % S.CAR_COLORS.length, cws: [999, 0, 0, 0], cwk: 0 });
      if (!S.carHits(map, c)) cars.set(c.id, c);
    });
    ev(['rl']); // everyone moved: clients snap their view
  }
  function stepRace() {
    if (!cps.length || !map.race.start) return;
    if (RACE.st === 0) {
      if (state !== 'play') return;
      const st = map.race.start;
      for (const p of players.values()) {
        const q = racePos(p);
        if (!q || p.bot || Math.hypot(q.x - st.x, q.y - st.y) > 44 || (q.z || 0) > 20) continue;
        RACE.st = 1; RACE.t = time + 3.5; RACE.by = p.id; RACE.win = 0;
        for (const r of players.values()) r.race = { lap: 0, next: 1 }; // bots race too
        raceLineUp();
        ev(['ra', 0, p.id]);
        return;
      }
    } else if (RACE.st === 1) {
      if (time >= RACE.t) { RACE.st = 2; RACE.t = time + RACE_MAX; ev(['ra', 1]); }
    } else if (RACE.st === 2) {
      // the pit never runs dry: while the race is on, a fresh boat is moored there whenever fewer than two are free
      const land = map.race.land;
      if (land && tick % 60 === 0) {
        const free = [...cars.values()].filter((o) => o.t === BOAT && !o.driver && !o.dead && !(o.burn > 0) && Math.hypot(o.x - land.x, o.y - land.y) < 450).length;
        const s = free < 2 && map.race.pit.find((q) => ![...cars.values()].some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 60) && ![...players.values()].some((o) => o.alive && Math.hypot(o.ped.x - q.x, o.ped.y - q.y) < 70));
        if (s) { const c = special(BOAT, s.x, s.y, s.a, { col: Math.floor(rand() * S.CAR_COLORS.length), cws: [999, 0, 0, 0], cwk: 0 }); if (!S.carHits(map, c)) cars.set(c.id, c); }
      }
      if (time >= RACE.t || state !== 'play') { RACE.st = 4; RACE.t = time + RACE_BACK; ev(['ra', 5]); for (const p of players.values()) p.race = null; return; }
      for (const p of players.values()) {
        if (!p.race) p.race = { lap: 0, next: 1 }; // joined mid-race: still in it
        const q = racePos(p), r = p.race;
        if (!q) continue;
        const c = cps[r.next];
        if (Math.hypot(q.x - c.x, q.y - c.y) > RACE_R) continue;
        if (c.w) { const pc = q.car && cars.get(q.car); if (!pc || pc.t !== BOAT) continue; } // out at sea: boats only
        if (r.next === 0) {
          r.lap++;
          if (r.lap >= RACE.laps) {
            RACE.st = 3; RACE.win = p.id; RACE.t = time + 8; p.score += 2500;
            // the winner takes a frag for every other racer
            const beaten = [...players.values()].filter((o) => o !== p && o.race).length;
            p.frags += beaten;
            ev(['ra', 4, p.id, r1(q.x), r1(q.y), beaten]);
            if (state === 'play' && beaten && p.frags >= FRAG_LIMIT) endMatch();
            return;
          }
          r.next = 1; ev(['ra', 3, p.id, r.lap]);
        } else {
          r.next = (r.next + 1) % cps.length; ev(['ra', 2, p.id, r.next]);
        }
      }
    } else if (RACE.st === 3) {
      if (time >= RACE.t) { RACE.st = 4; RACE.t = time + RACE_BACK; for (const p of players.values()) p.race = null; ev(['ra', 6]); }
    } else if (RACE.st === 4) {
      if (time >= RACE.t) { raceReset(); ev(['ra', 7]); }
    }
  }
  function newMatch() {
    raceReset();
    state = 'play'; matchEnd = time + TIME_LIMIT; winner = 0;
    cancelDuels();
    for (const p of players.values()) {
      if (p.alive && p.ped.car) exitCar(p, false);
      p.frags = 0; p.deaths = 0; p.score = 0; p.hpPts = 0; p.alive = false; p.respawnAt = time + 0.5;
    }
    projs = []; hazards = [];
    for (const n of [...npcs.values()]) if (n.kind === 1) npcs.delete(n.id);
    for (const n of npcs.values()) if (n.kind === 2) { n.owner = 0; n.foe = 0; }
    for (const q of players.values()) q.ride = [];
    ev(['n']);
  }

  function send(p, obj) { if (p.send) p.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  function broadcast(obj) { const s = JSON.stringify(obj); for (const p of players.values()) send(p, s); }
  function sendRoster() { broadcast({ t: 'r', l: [...players.values()].map((p) => [p.id, p.name, p.color, p.bot ? 1 : 0]) }); }
  function sendSnaps() {
    const P = [], C = [], PR = [];
    for (const p of players.values()) {
      if (!p.alive) continue;
      const d = p.ped;
      const fl = (d.fire > 0 ? 1 : 0) | (p.invis > 0 ? 2 : 0) | (p.quad > 0 ? 4 : 0) | (d.ar > 0 ? 8 : 0) | (p.curK & K.FIRE && !d.car ? 16 : 0);
      P.push([p.id, r1(d.x), r1(d.y), r3(d.a), Math.max(0, Math.ceil(d.hp)), fl, d.car, p.w, d.mv ? 1 : 0, r1(d.z || 0)]);
    }
    for (const c of cars.values()) {
      const C2 = S.carStats(c);
      const tier = c.dead ? 0 : c.hp < C2.hp * 0.25 ? 3 : c.hp < C2.hp * 0.5 ? 2 : c.hp < C2.hp * 0.8 ? 1 : 0;
      const fl = (c.dead ? 1 : 0) | (c.burn > 0 ? 2 : 0) | (!c.dead && c.hp < C2.hp * 0.4 ? 4 : 0) | (c.oil > 0 ? 8 : 0) | (tier << 4) | (c.siren && !c.dead ? 64 : 0) | (c.t === HELI && c.hm >= 1 && c.hm <= 3 ? 128 : 0) | (c.hm === 3 ? 256 : 0) | (c.fadeAt ? 512 : 0);
      const drv = c.driver ? players.get(c.driver) : null;
      const fl2 = fl | (drv && drv.ride ? Math.min(3, drv.ride.length) << 10 : 0); // passengers
      C.push([c.id, c.t, c.col, r1(c.x), r1(c.y), r3(c.a), r1(c.vx), r1(c.vy), fl2, c.driver, drv ? drv.curK & (K.HAND | K.UP | K.DOWN) : c.ai ? c.ai.k & (K.UP | K.DOWN) : 0, (c.up & 7) | (c.t !== HELI && cwSel(c) >= 0 ? 8 : 0), r1(c.z || 0)]);
    }
    for (const pr of projs) PR.push([pr.id, pr.k, r1(pr.x), r1(pr.y), r1(pr.z || 0)]);
    const N = [];
    for (const n of npcs.values()) N.push([n.id, r1(n.x), r1(n.y), r3(n.a), (n.kind === 1 ? 1 : 0) | (n.fire > 0 ? 2 : 0) | (n.panic > time ? 4 : 0) | (n.kind === 2 ? 8 : 0) | (n.kind === 2 && (n.owner || (n.foe && time < n.foeT)) ? 16 : 0) | (n.gun === 2 ? 32 : 0), n.mv ? 1 : 0, n.owner || 0]);
    for (const h of hazards) PR.push([h.id, h.k, r1(h.x), r1(h.y), Math.ceil(Math.min(h.life, 9) * 10) / 10]);
    const g = { st: state, tl: Math.max(0, Math.ceil((state === 'play' ? matchEnd : overUntil) - time)), fl: FRAG_LIMIT, win: winner, po: POLICE ? 1 : 0, bn: FILL_BOTS, bs: BOT_SKILL };
    // race: [state, seconds left, winner, started by, laps, then id, lap, next checkpoint for each racer]
    if (cps.length) {
      g.rc = [RACE.st, Math.max(0, Math.ceil(RACE.t - time)), RACE.win, RACE.by, RACE.laps];
      if (RACE.st === 1 || RACE.st === 2) for (const p of players.values()) if (p.race) g.rc.push(p.id, p.race.lap, p.race.next);
    }
    if (duels.size) {
      g.du = [];
      for (const d of duels.values()) { const c = cars.get(d.car); g.du.push([d.id, d.A.id, d.B.id, r1(d.wx), r1(d.wy), c ? c.t : 0, c ? c.col : 0, ...S.Fight.save(d)]); }
    }
    const base = { t: 's', tm: Math.round(time * 1000), P, C, PR, N, pk: pickups.map((p) => (p.active ? 1 : 0)).join(''), ev: events, g };
    if (tick % 30 === 0) base.sb = [...players.values()].map((p) => [p.id, p.frags, p.deaths, p.score, p.ping || 0]);
    // full-precision personal state for every human (used by local senders and the room host)
    const mes = [];
    for (const p of players.values()) {
      if (p.bot) continue;
      const d = p.ped;
      const me = { cu: p.cuff && time < p.cuff.until ? Math.ceil((p.cuff.until - time) * 10) / 10 : 0, wl: stars(p), wi: Math.round(interest(p) * 100), al: p.alive ? 1 : 0, rs: p.alive ? 0 : Math.max(0, Math.ceil(p.respawnAt - time)), inv: p.inv.slice(), w: p.w, fr: p.frags, sc: p.score, q: Math.ceil(Math.max(0, p.quad)), iv: Math.ceil(Math.max(0, p.invis)) };
      if (p.alive) {
        me.hp = Math.max(0, Math.ceil(d.hp)); me.ar = Math.ceil(d.ar);
        me.ped = [r3(d.x), r3(d.y), r3(d.a), r3(d.kx), r3(d.ky), r3(d.z), r3(d.vz), r3(d.jvx), r3(d.jvy), r3(d.gz), d.sl ? 1 : 0, r3(Math.max(0, d.nj || 0))];
        if (d.car) { const c = cars.get(d.car); if (c) { const k = cwSel(c); me.car = [r3(c.x), r3(c.y), r3(c.a), r3(c.vx), r3(c.vy), r3(c.spin), r3(c.oil), c.t, (c.up & 7) | (c.t !== HELI && k >= 0 ? 8 : 0), r3(c.z || 0), r3(c.vz || 0), c.hm || 0]; me.cw = k >= 0 && !p.footSel ? [k, c.cws[k], c.cws.filter((n) => n > 0).length] : null; } }
        me.cr = crewOf(p);
      }
      mes.push({ p, me, a: p.lastSeq + (p.guessed || 0) }); // ticks played on a guess count as done
    }
    if (opts.onSnap) opts.onSnap({ tm: base.tm, P, C, PR, N, pk: base.pk, ev: events, g, sb: [...players.values()].map((p) => [p.id, p.frags, p.deaths, p.score, p.ping || 0]), mes });
    events = [];
    delete base.C; delete base.PR; delete base.N;
    const head = JSON.stringify(base).slice(0, -1);
    const VIEW = 1900;
    for (const { p, me } of mes) {
      if (!p.send) continue;
      const d = p.ped;
      const fx = d ? d.x : 0, fy = d ? d.y : 0;
      const near = (r) => !d || (Math.abs(r[3] - fx) < VIEW && Math.abs(r[4] - fy) < VIEW);
      const nearP = (r) => !d || (Math.abs(r[2] - fx) < VIEW && Math.abs(r[3] - fy) < VIEW);
      const ownCar = d && p.alive && d.car;
      const vc = C.filter((r) => r[0] === ownCar || near(r)), vp = PR.filter(nearP);
      const vn = N.filter((r) => !d || (Math.abs(r[1] - fx) < VIEW && Math.abs(r[2] - fy) < VIEW));
      send(p, head + ',"C":' + JSON.stringify(vc) + ',"PR":' + JSON.stringify(vp) + ',"N":' + JSON.stringify(vn) + ',"a":' + (p.lastSeq + (p.guessed || 0)) + ',"me":' + JSON.stringify(me) + '}');
    }
  }


  // one connection per human; sendFn(str) delivers messages to that player's client (or null for remote room players)
  function connect(sendFn) {
    let p = null;
    return {
      get player() { return p; },
      message(m) {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'j' && !p) {
          const name = String(m.n || 'Player').replace(/[^\w \-.!?]/g, '').slice(0, 16) || 'Player';
          const color = S.PLAYER_COLORS.includes(m.c) ? m.c : S.PLAYER_COLORS[0];
          p = newPlayer(name, color, false);
          p.send = sendFn; p.peer = m.peer || null;
          if (m.carry) { p.frags = m.carry.fr | 0; p.deaths = m.carry.de | 0; p.score = m.carry.sc | 0; }
          send(p, { t: 'w', id: p.id, seed: SEED, ms: map.size, is: map.islands, pk: pickups.map((q) => [q.id, q.x, q.y, q.k]) });
          syncBots(); sendRoster();
          if (!m.quiet) ev(['c', 0, name + ' joined the city']);
          return;
        }
        if (!p) return;
        if (m.t === 'i') {
          for (const [s, k] of m.l || []) if (s > p.lastSeq && (p.q.length === 0 || s > p.q[p.q.length - 1].s)) p.q.push({ s, k: k | 0 });
          if (typeof m.v === 'number' && m.v >= 0) p.view = Math.min(LAG_MAX, m.v / 1000); // how old the cars on their screen are
        } else if (m.t === 'a') {
          if (m.a === 'e') actEnter(p);
          else if (m.a === 'n' && p.alive) cycleWeapon(p, 1);
          else if (m.a === 'p' && p.alive) cycleWeapon(p, -1);
          else if (m.a === 'h' && p.alive && p.ped.car) { ev(['h', p.ped.car]); recruit(p); }
          else if (m.a === 'y' || m.a === 'q') answerFight(p, m.a === 'y');
          // bots, from the menu: + / - how many, > / < how good. Anyone can change them, like the police
          else if ('+-<>'.includes(m.a) && m.a) {
            if (m.a === '+' || m.a === '-') { FILL_BOTS = Math.max(0, Math.min(8, FILL_BOTS + (m.a === '+' ? 1 : -1))); syncBots(); }
            else BOT_SKILL = Math.max(1, Math.min(5, BOT_SKILL + (m.a === '>' ? 1 : -1)));
            ev(['bo', FILL_BOTS, BOT_SKILL, p.id]);
          }
          else if (m.a === 'c') {
            POLICE = !POLICE;
            if (!POLICE) { for (const n of [...npcs.values()]) if (n.kind === 1) { npcs.delete(n.id); const c = cars.get(n.car); if (c) c.siren = false; } for (const q of players.values()) q.heat = 0; }
            ev(['c', 0, p.name + (POLICE ? ' turned the police on' : ' turned the police off')]);
          }
          else if (m.a === 'r' && time - lastRestart > 5) { lastRestart = time; newMatch(); ev(['c', 0, p.name + ' restarted the match']); }
        } else if (m.t === 'pi') {
          p.ping = m.r | 0;
          send(p, { t: 'po', c: m.c });
        } else if (m.t === 'c') {
          const txt = String(m.m || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').slice(0, 120).trim();
          if (txt) ev(['c', p.id, txt]);
        }
      },
      close() {
        if (!p || !players.has(p.id)) return;
        removePlayer(p);
        ev(['c', 0, p.name + ' left']);
        syncBots(); sendRoster();
      },
    };
  }

  // fixed-step driver: call with elapsed seconds; runs whole 1/60 s steps
  let acc = 0;
  function advance(dt) {
    acc = Math.min(acc + dt, 0.25);
    while (acc >= DT) { acc -= DT; if (players.size) step(); }
  }

  return {
    map, seed: SEED, players, cars, duels, npcs, connect, advance, step,
    get time() { return time; },
    setBots(n) { FILL_BOTS = Math.max(0, Math.min(8, n | 0)); syncBots(); },
    setSkill(n) { BOT_SKILL = Math.max(1, Math.min(5, n | 0 || 3)); },
    botInfo() { return { b: FILL_BOTS, k: BOT_SKILL }; },
    timeLeft() { return Math.max(0, Math.ceil((state === 'play' ? matchEnd : overUntil) - time)); },
  };

  };
  return S;
});
