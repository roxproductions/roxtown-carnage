// RoxTown Carnage — code shared by server and browser (map generation, physics, tables).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const S = {};
  const TILE = (S.TILE = 64);
  S.DT = 1 / 60;
  S.LEVEL = 30; // world units per storey
  const T = (S.T = { ROAD: 0, PAVE: 1, GRASS: 2, BUILD: 3, WATER: 4 });
  // HAND is the Space key: handbrake in a car, jump on foot (as in GTA2)
  const K = (S.K = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16, HAND: 32, ABS: 64 });

  S.rng = function (a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  S.hash = function (x, y, s) {
    let h = (x * 374761393 + y * 668265263 + (s | 0) * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  S.wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  S.angDiff = (a, b) => S.wrapA(a - b);

  // ---------------------------------------------------------------- tables
  // rate = seconds between shots, pick = ammo per crate
  S.WEAPONS = [
    { id: 'pistol', name: 'PISTOL', rate: 0.3, dmg: 24, range: 620, spread: 0.03, pick: 40 },
    { id: 'dual', name: 'DUAL PISTOL', rate: 0.16, dmg: 22, range: 620, spread: 0.05, pick: 60 },
    { id: 'mg', name: 'MACHINE GUN', rate: 0.075, dmg: 13, range: 660, spread: 0.075, pick: 120 },
    { id: 'shotgun', name: 'SHOTGUN', rate: 0.8, dmg: 12, pellets: 8, range: 340, spread: 0.3, pick: 16 },
    { id: 'electro', name: 'ELECTRO GUN', rate: 0.05, dmg: 9, range: 260, pick: 160 },
    { id: 'flamer', name: 'FLAMETHROWER', rate: 0.05, dmg: 3, range: 190, pick: 200 },
    { id: 'rocket', name: 'ROCKET LAUNCHER', rate: 1.0, pick: 8 },
    { id: 'grenade', name: 'GRENADES', rate: 0.8, pick: 8 },
    { id: 'molotov', name: 'MOLOTOVS', rate: 0.8, pick: 8 },
  ];
  S.FISTS = 9; // weapon slot 9: bare fists, always available
  S.CARWEAPONS = [
    { id: 'cmg', name: 'VEHICLE GUN', rate: 0.09, dmg: 14, range: 620, pick: 160 },
    { id: 'oil', name: 'OIL SLICK', rate: 0.1, pick: 6 }, // drop them as fast as you like
    { id: 'mines', name: 'CAR MINES', rate: 0.1, pick: 6 },
    { id: 'jump', name: 'CAR JUMP', rate: 0.35, pick: 5 },
    { id: 'missile', name: 'MISSILES', rate: 0.45, pick: 10 }, // helicopters only
  ];
  // pickup kinds: 0..8 weapons, 20 health, 21 armour, 22 double damage, 23 invisibility, 30..32 car weapons
  S.PK_NAMES = { 20: 'HEALTH', 21: 'ARMOUR', 22: 'DOUBLE DAMAGE', 23: 'INVISIBILITY' };
  S.pickupName = (k) => (k < 20 ? S.WEAPONS[k].name : k >= 30 ? S.CARWEAPONS[k - 30].name : S.PK_NAMES[k]);

  S.CARS = [
    { name: 'COUPE', h: 16, kind: 'car', len: 46, wid: 22, max: 430, acc: 330, rev: 150, turn: 2.7, grip: 7.5, hp: 255, mass: 1 },
    { name: 'SPEEDSTER', h: 13, kind: 'sports', len: 47, wid: 22, max: 560, acc: 430, rev: 160, turn: 2.9, grip: 8, hp: 215, mass: 0.9 },
    { name: 'SEDAN', h: 17, kind: 'car', len: 50, wid: 24, max: 400, acc: 290, rev: 140, turn: 2.5, grip: 7, hp: 295, mass: 1.1 },
    { name: 'CAB', h: 17, kind: 'taxi', len: 50, wid: 24, max: 410, acc: 300, rev: 140, turn: 2.5, grip: 7, hp: 295, mass: 1.1 },
    { name: 'PICKUP', h: 18, kind: 'pickup', len: 54, wid: 25, max: 380, acc: 270, rev: 140, turn: 2.3, grip: 6.5, hp: 365, mass: 1.3 },
    { name: 'BOX VAN', h: 27, kind: 'van', len: 58, wid: 27, max: 330, acc: 230, rev: 120, turn: 2.1, grip: 6, hp: 445, mass: 1.6 },
    { name: 'CITY BUS', h: 32, kind: 'bus', len: 100, wid: 31, max: 270, acc: 170, rev: 100, turn: 1.45, grip: 5.5, hp: 700, mass: 3 },
    { name: 'BRUISER', h: 15, kind: 'muscle', len: 50, wid: 24, max: 500, acc: 400, rev: 150, turn: 2.6, grip: 6.8, hp: 325, mass: 1.25 },
    { name: 'POLICE CAR', h: 17, kind: 'police', len: 50, wid: 24, max: 470, acc: 360, rev: 150, turn: 2.6, grip: 7.6, hp: 350, mass: 1.2 },
    { name: 'HELICOPTER', h: 20, kind: 'heli', len: 56, wid: 22, max: 380, acc: 280, rev: 160, turn: 2.3, grip: 3, hp: 999, mass: 2 },
  ];
  S.HELI = 9; // index of the helicopter in S.CARS
  // car upgrades, found on some cars around the city
  S.UP = { TURBO: 1, ARMOR: 2, GRIP: 4, ARMED: 8 };
  S.UP_NAMES = [[1, 'TURBO'], [2, 'ARMOUR'], [4, 'SPORT GRIP'], [8, 'MOUNTED WEAPON']];
  const statCache = {};
  S.carStats = function (c) {
    const up = (c.up || 0) & 7;
    if (!up) return S.CARS[c.t];
    const key = c.t * 8 + up;
    if (statCache[key]) return statCache[key];
    const C = Object.assign({}, S.CARS[c.t]);
    if (up & 1) { C.max *= 1.25; C.acc *= 1.45; }
    if (up & 4) { C.grip *= 1.45; C.turn *= 1.15; }
    if (up & 2) { C.hp *= 1.8; C.mass *= 1.35; C.max *= 0.95; C.acc *= 0.9; }
    return (statCache[key] = C);
  };
  S.CAR_COLORS = ['#c4302b', '#2f5fb3', '#e8e6df', '#26282b', '#3d8b45', '#e2b021', '#7b3fa0', '#e07126', '#9aa3ab', '#1f9a96', '#8a2d2d', '#5f7f3a'];
  S.PLAYER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#f06292', '#eeeeee', '#6d4c41'];
  S.DISTRICTS = ['RUST QUARTER', 'LOW HOLLOW', 'NEON ROW', 'CANAL HEIGHTS', 'OLD DOCKS', 'BRICKWORKS', 'SAINT VALE', 'GLASS MILE', 'PALM CROSS', 'IRON YARDS', 'MIDTOWN', 'SOUTH BEND'];

  // ---------------------------------------------------------------- map
  // o.size: 0 small, 1 medium, 2 large. o.islands: 0-2 areas cut off by rivers, reachable only over bridges
  S.MAP_SIZES = ['SMALL', 'MEDIUM', 'LARGE'];
  S.BOT_SKILLS = ['', 'ROOKIE', 'EASY', 'STREETWISE', 'HARD', 'PSYCHO'];
  S.PAD_LV = 7; // helipad buildings: taller than any other (5 storeys at most), out of reach of roof jumps
  S.TRAMP = 760; // a trampoline bounce: high enough to get up there
  S.TRAMP_R = 21;
  S.KERB = 17; // how far parked cars sit from the middle of their lane
  S.genMap = function (seed, o) {
    o = o || {};
    const size = Math.max(0, Math.min(2, o.size == null ? 1 : o.size | 0));
    const islands = Math.max(0, Math.min(2, o.islands | 0));
    const R = S.rng(seed);
    const W = [64, 88, 116][size], H = W;
    const NB = [4, 6, 8][size], SC = (a) => a[size];
    const tiles = new Uint8Array(W * H).fill(T.WATER);
    const heights = new Float32Array(W * H); // roof height of each building tile
    const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) tiles[y * W + x] = v; };
    const get = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T.WATER : tiles[y * W + x]);
    const L = 4, Hi = W - 5;
    for (let y = L - 1; y <= Hi + 1; y++) for (let x = L - 1; x <= Hi + 1; x++) set(x, y, T.PAVE);
    function cuts() {
      const N = Hi - L + 1, n = NB, total = N - (n + 1) * 2;
      const ws = []; for (let i = 0; i < n; i++) ws.push(0.7 + R() * 0.6);
      const s = ws.reduce((a, b) => a + b, 0);
      const sizes = ws.map((w) => Math.max(7, Math.round((w / s) * total)));
      let diff = total - sizes.reduce((a, b) => a + b, 0), i = 0;
      while (diff !== 0 && i < 1000) { const j = i % n; if (diff > 0) { sizes[j]++; diff--; } else if (sizes[j] > 7) { sizes[j]--; diff++; } i++; }
      const roads = [], blocks = []; let p = L;
      for (let k = 0; k < n; k++) { roads.push(p); p += 2; blocks.push([p, sizes[k]]); p += sizes[k]; }
      roads.push(p);
      return { roads, blocks };
    }
    const cx = cuts(), cy = cuts();
    const roadCols = new Set(), roadRows = new Set();
    for (const r of cx.roads) { roadCols.add(r); roadCols.add(r + 1); }
    for (const r of cy.roads) { roadRows.add(r); roadRows.add(r + 1); }
    for (const x of roadCols) for (let y = L; y <= Hi; y++) set(x, y, T.ROAD);
    for (const y of roadRows) for (let x = L; x <= Hi; x++) set(x, y, T.ROAD);

    // rivers: replace a road with water; only a few bridges cross. Own RNG so the rest of the city doesn't change.
    const bridges = [], rail = new Uint8Array(W * H), ramps = [];
    if (islands) {
      const RR = S.rng((seed ^ 0x5bd1e995) >>> 0);
      const pickIdx = (roads, lo, hi) => {
        const c = []; for (let k = 1; k < roads.length - 1; k++) { const f = (roads[k] - L) / (Hi - L); if (f >= lo && f <= hi) c.push(k); }
        if (!c.length) for (let k = 1; k < roads.length - 1; k++) c.push(k);
        return c[Math.floor(RR() * c.length)];
      };
      const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(RR() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      const kx = pickIdx(cx.roads, 0.55, 0.8), rx = cx.roads[kx];
      let ky = -1, ry = -1;
      if (islands > 1) { ky = pickIdx(cy.roads, 0.45, 0.75); ry = cy.roads[ky]; }
      for (let y = L - 1; y <= Hi + 1; y++) { set(rx, y, T.WATER); set(rx + 1, y, T.WATER); }
      roadCols.delete(rx); roadCols.delete(rx + 1);
      if (islands > 1) for (let x = L - 1; x < rx; x++) { set(x, ry, T.WATER); set(x, ry + 1, T.WATER); }
      // bridges over the east river: at least one each side of the second river
      const rows = []; for (let k = 1; k < cy.roads.length - 1; k++) if (k !== ky) rows.push(k);
      const vb = shuffle(rows.slice()).slice(0, size === 2 ? 3 : 2);
      if (islands > 1) {
        if (!vb.some((k) => k < ky)) { const a = rows.filter((k) => k < ky); if (a.length) vb[0] = a[Math.floor(RR() * a.length)]; }
        if (!vb.some((k) => k > ky)) { const a = rows.filter((k) => k > ky); if (a.length) vb[vb.length - 1] = a[Math.floor(RR() * a.length)]; }
      }
      for (const k of new Set(vb)) bridges.push({ x: rx, y: cy.roads[k], v: 0 });
      if (islands > 1) {
        const cols = []; for (let k = 1; k < kx; k++) cols.push(k);
        for (const k of shuffle(cols).slice(0, size === 0 ? 1 : 2)) bridges.push({ x: cx.roads[k], y: ry, v: 1 });
      }
      for (const b of bridges) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) set(b.x + i, b.y + j, T.ROAD);
      // railings along bridge decks and barriers where a road ends at the river: water next to road is a wall
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        if (get(x, y) !== T.WATER) continue;
        if (get(x + 1, y) === T.ROAD || get(x - 1, y) === T.ROAD || get(x, y + 1) === T.ROAD || get(x, y - 1) === T.ROAD) rail[y * W + x] = 1;
      }
      // river jumps: on a road or two that dead-ends at the river, a ramp in each lane that heads for the water.
      // Hit it fast enough and you fly across; too slow and you're swimming.
      const nJ = size === 2 ? 2 : 1;
      const bRows = new Set(bridges.filter((b) => !b.v).map((b) => b.y)), bCols = new Set(bridges.filter((b) => b.v).map((b) => b.x));
      const rowsX = shuffle(cy.roads.filter((r, k) => k > 0 && k < cy.roads.length - 1 && r !== ry && !bRows.has(r) && get(rx - 1, r) === T.ROAD && get(rx + 2, r) === T.ROAD)).slice(0, nJ);
      for (const r of rowsX) { ramps.push({ x: rx - 1, y: r + 1, d: 0 }); ramps.push({ x: rx + 2, y: r, d: 2 }); }
      if (islands > 1) {
        const colsX = shuffle(cx.roads.filter((c2, k) => k > 0 && k < kx && !bCols.has(c2) && get(c2, ry - 1) === T.ROAD && get(c2, ry + 2) === T.ROAD)).slice(0, nJ);
        for (const c2 of colsX) { ramps.push({ x: c2, y: ry - 1, d: 1 }); ramps.push({ x: c2 + 1, y: ry + 2, d: 3 }); }
      }
    }

    const buildings = [], trees = [], lots = [];
    function building(x, y, w, h) {
      if (R() < 0.08) { lots.push({ x, y, w, h }); return; }
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, T.BUILD);
      const lv = 1 + Math.floor(Math.pow(R(), 1.6) * 5);
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) heights[j * W + i] = lv * S.LEVEL;
      buildings.push({ x, y, w, h, lv, st: Math.floor(R() * 8), sd: Math.floor(R() * 1e6) });
    }
    function split(x, y, w, h, d) {
      if (w <= 0 || h <= 0) return;
      if ((w <= 5 && h <= 5) || (d > 1 && R() < 0.25 && w <= 8 && h <= 8)) return building(x, y, w, h);
      const alley = R() < 0.35 ? 1 : 0;
      if (w >= h) {
        const c = 2 + Math.floor(R() * (w - 4 - alley + 1));
        split(x, y, c, h, d + 1); split(x + c + alley, y, w - c - alley, h, d + 1);
      } else {
        const c = 2 + Math.floor(R() * (h - 4 - alley + 1));
        split(x, y, w, c, d + 1); split(x, y + c + alley, w, h - c - alley, d + 1);
      }
    }
    for (const [bx, bw] of cx.blocks) for (const [by, bh] of cy.blocks) {
      const ix = bx + 1, iy = by + 1, iw = bw - 2, ih = bh - 2;
      const r = R();
      if (r < 0.13) {
        for (let j = iy; j < iy + ih; j++) for (let i = ix; i < ix + iw; i++) set(i, j, T.GRASS);
        const n = Math.floor(iw * ih * 0.12);
        for (let k = 0; k < n; k++) trees.push({ x: (ix + 0.5 + R() * (iw - 1)) * TILE, y: (iy + 0.5 + R() * (ih - 1)) * TILE, r: 16 + R() * 10 });
      } else if (r < 0.19) {
        lots.push({ x: ix, y: iy, w: iw, h: ih });
      } else split(ix, iy, iw, ih, 0);
    }

    // hidden helicopters: on top of a few buildings taller than anything else in town (7 storeys: no chain of roof
    // jumps gets you up there). The only way up is a trampoline tucked away at the foot of the building, off the
    // main road where possible. Own RNG, so nothing else about the city changes.
    const helipads = [], tramps = [];
    {
      const RH = S.rng((seed ^ 0x2545f491) >>> 0);
      const want = [1, 2, 3][size];
      const cands = buildings.filter((b) => b.w >= 2 && b.h >= 2).sort(() => RH() - 0.5);
      const isRoadT = (x, y) => get(x, y) === T.ROAD;
      for (const T0 of cands) {
        if (helipads.length >= want) break;
        if (helipads.some((h) => Math.hypot(h.x / TILE - (T0.x + T0.w / 2), h.y / TILE - (T0.y + T0.h / 2)) < 12)) continue;
        // a spot right against its wall, on pavement or grass; out of the way beats next to the road
        const spots = [];
        for (let i = T0.x; i < T0.x + T0.w; i++) { spots.push([i, T0.y - 1, 0, 1]); spots.push([i, T0.y + T0.h, 0, -1]); }
        for (let j = T0.y; j < T0.y + T0.h; j++) { spots.push([T0.x - 1, j, 1, 0]); spots.push([T0.x + T0.w, j, -1, 0]); }
        const ok = spots.filter(([x, y]) => get(x, y) === T.PAVE || get(x, y) === T.GRASS)
          .map((sp) => [sp, (isRoadT(sp[0] + 1, sp[1]) || isRoadT(sp[0] - 1, sp[1]) || isRoadT(sp[0], sp[1] + 1) || isRoadT(sp[0], sp[1] - 1) ? 2 : 0) + RH()])
          .sort((a, b) => a[1] - b[1]);
        if (!ok.length) continue;
        const [tx, ty, wx, wy] = ok[0][0];
        T0.lv = S.PAD_LV; T0.pad = 1;
        for (let j = T0.y; j < T0.y + T0.h; j++) for (let i = T0.x; i < T0.x + T0.w; i++) heights[j * W + i] = S.PAD_LV * S.LEVEL;
        helipads.push({ x: (T0.x + T0.w / 2) * TILE, y: (T0.y + T0.h / 2) * TILE, z: S.PAD_LV * S.LEVEL, a: RH() * Math.PI * 2 });
        tramps.push({ x: (tx + 0.5) * TILE + wx * 6, y: (ty + 0.5) * TILE + wy * 6 }); // nudged towards the wall
      }
    }

    // secret chop shops: a roller door in the wall of a low building, opening onto the pavement with a road just
    // beyond, so you can drive straight in. Unmarked on the map. Own RNG, so nothing else about the city changes.
    const shops = [];
    {
      const RS = S.rng((seed ^ 0x6c0ffee5) >>> 0);
      const want = [2, 2, 3][size];
      const cands = buildings.map((b, i) => [b, i]).filter(([b]) => !b.pad && b.lv <= 3 && b.w >= 2 && b.h >= 2).sort(() => RS() - 0.5);
      for (const [b, bi] of cands) {
        if (shops.length >= want) break;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (shops.some((o) => Math.hypot(o.x / TILE - cx, o.y / TILE - cy) < 14)) continue;
        if (helipads.some((h) => Math.hypot(h.x / TILE - cx, h.y / TILE - cy) < 6)) continue;
        // a door spot: pavement against the wall (wx, wy points into the building), road right behind it
        const spots = [];
        for (let i = b.x; i < b.x + b.w; i++) { spots.push([i, b.y - 1, 0, 1]); spots.push([i, b.y + b.h, 0, -1]); }
        for (let j = b.y; j < b.y + b.h; j++) { spots.push([b.x - 1, j, 1, 0]); spots.push([b.x + b.w, j, -1, 0]); }
        const ok = spots.filter(([x, y, wx, wy]) => get(x, y) === T.PAVE && get(x - wx, y - wy) === T.ROAD && get(x - wy, y + wx) !== T.BUILD && get(x + wy, y - wx) !== T.BUILD
          && !tramps.some((t) => Math.hypot(t.x / TILE - x - 0.5, t.y / TILE - y - 0.5) < 2));
        if (!ok.length) continue;
        const [tx, ty, wx, wy] = ok[Math.floor(RS() * ok.length)];
        // x, y: where you park to drive in, tucked against the door
        shops.push({ b: bi, x: (tx + 0.5) * TILE + wx * 14, y: (ty + 0.5) * TILE + wy * 14, dx: (tx + 0.5) * TILE + wx * 32, dy: (ty + 0.5) * TILE + wy * 32, wx, wy });
      }
    }

    // spawn & item spots
    const isRoad = (x, y) => get(x, y) === T.ROAD;
    const pave = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (get(x, y) !== T.PAVE) continue;
      if (isRoad(x + 1, y) || isRoad(x - 1, y) || isRoad(x, y + 1) || isRoad(x, y - 1) || R() < 0.15) pave.push([x, y]);
    }
    function pickSpots(list, n, minD) {
      const out = [], pool = list.slice();
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      for (const s of pool) {
        if (out.length >= n) break;
        if (out.every((o) => Math.abs(o[0] - s[0]) + Math.abs(o[1] - s[1]) >= minD)) out.push(s);
      }
      return out;
    }
    const spawns = pickSpots(pave, SC([36, 48, 64]), 4).map(([x, y]) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE }));
    const pickupSpots = pickSpots(pave, SC([30, 44, 64]), 6).map(([x, y]) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE }));
    const roadT = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!isRoad(x, y)) continue;
      const v = roadCols.has(x), h = roadRows.has(y);
      if (v && h) continue;
      // keep away from intersections
      let near = false;
      for (let d = -2; d <= 2; d++) { if (v && roadRows.has(y + d)) near = true; if (h && roadCols.has(x + d)) near = true; }
      if (!near) roadT.push([x, y]);
    }
    const carSpots = pickSpots(roadT, SC([45, 70, 100]), 4).map(([x, y]) => {
      let a;
      // parked against the kerb, leaving the lane free for traffic
      let ox = 0, oy = 0;
      if (roadCols.has(x)) { a = roadCols.has(x + 1) ? Math.PI / 2 : -Math.PI / 2; ox = roadCols.has(x + 1) ? -S.KERB : S.KERB; }
      else { a = roadRows.has(y + 1) ? Math.PI : 0; oy = roadRows.has(y + 1) ? -S.KERB : S.KERB; }
      return { x: (x + 0.5) * TILE + ox, y: (y + 0.5) * TILE + oy, a };
    });
    for (const l of lots) {
      for (let i = 0; i < l.w - 1; i += 2) if (l.h >= 2 && R() < 0.5) carSpots.push({ x: (l.x + i + 1) * TILE, y: (l.y + 0.9) * TILE, a: Math.PI / 2 });
    }
    const cwSpots = pickSpots(roadT, SC([7, 10, 14]), 14).map(([x, y]) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE }));
    // race mode: a loop of checkpoints around the city (the first one is the start/finish line, across the road) and
    // one race-start pickup on a road somewhere. Own RNG, so nothing else about the city changes.
    const race = { cps: [], start: null };
    {
      const RR = S.rng((seed ^ 0x51ed270b) >>> 0);
      const at = (x, y) => {
        // the middle of the two-lane road at this tile, and which way the road runs
        if (roadCols.has(x)) { const c0 = roadCols.has(x + 1) ? x : x - 1; return { x: (c0 + 1) * TILE, y: (y + 0.5) * TILE, v: 1 }; }
        const r0 = roadRows.has(y + 1) ? y : y - 1;
        return { x: (x + 0.5) * TILE, y: (r0 + 1) * TILE, v: 0 };
      };
      const n = [8, 10, 12][size], off = RR() * Math.PI * 2, cx = W / 2, cy = H / 2;
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * Math.PI * 2, rr = 0.3 + RR() * 0.08;
        const tx = cx + Math.cos(a) * W * rr, ty = cy + Math.sin(a) * H * rr;
        let best = null, bd = 1e9;
        for (const t of roadT) { const d = Math.hypot(t[0] - tx, t[1] - ty); if (d < bd) { bd = d; best = t; } }
        if (!best) continue;
        const cp = at(best[0], best[1]);
        if (race.cps.some((o) => Math.hypot(o.x - cp.x, o.y - cp.y) < 6 * TILE)) continue;
        race.cps.push(cp);
      }
      let sb = null, sd = -1;
      for (let k = 0; k < 40; k++) {
        const t = roadT[Math.floor(RR() * roadT.length)];
        if (!t) break;
        const p0 = at(t[0], t[1]);
        const d = Math.min(...race.cps.map((c) => Math.hypot(c.x - p0.x, c.y - p0.y)), 1e9);
        if (d > 8 * TILE) { sb = p0; break; }
        if (d > sd) { sd = d; sb = p0; }
      }
      race.start = sb;
    }
    const dn = S.DISTRICTS.slice();
    for (let i = dn.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [dn[i], dn[j]] = [dn[j], dn[i]]; }
    return {
      seed, size, islands, bridges, rail, ramps, helipads, tramps, shops, race, rampAt: new Map(ramps.map((r) => [r.y * W + r.x, r.d])), w: W, h: H, tiles, heights, buildings, trees, lots, spawns, pickupSpots, carSpots, cwSpots,
      roadCols, roadRows, districts: dn.slice(0, 9),
    };
  };
  S.district = (m, x, y) => {
    const dx = Math.max(0, Math.min(2, Math.floor(x / ((m.w * TILE) / 3))));
    const dy = Math.max(0, Math.min(2, Math.floor(y / ((m.h * TILE) / 3))));
    return m.districts[dy * 3 + dx];
  };

  // ---------------------------------------------------------------- collision
  S.tile = (m, tx, ty) => (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h ? T.WATER : m.tiles[ty * m.w + tx]);
  S.tileW = (m, x, y) => S.tile(m, Math.floor(x / TILE), Math.floor(y / TILE));
  // drowning has a grace band along the shore: you only go under once you are this far out (about a car's width)
  S.SHORE = 24;
  S.deepWater = (m, x, y, g = S.SHORE) => {
    if (S.tileW(m, x, y) !== T.WATER) return false;
    for (const [dx, dy] of [[-g, 0], [g, 0], [0, -g], [0, g], [-g * 0.7, -g * 0.7], [g * 0.7, -g * 0.7], [-g * 0.7, g * 0.7], [g * 0.7, g * 0.7]])
      if (S.tileW(m, x + dx, y + dy) !== T.WATER) return false;
    return true;
  };
  S.solid = (m, x, y) => S.tileW(m, x, y) === T.BUILD;
  // walls for cars: buildings plus bridge railings
  S.wall = (m, x, y, z = 0) => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE), t = S.tile(m, tx, ty);
    if (t === T.BUILD) return m.heights[ty * m.w + tx] > z + 6; // a low roof is no wall once a jumping car is up level with it
    return !(z > 0) && t === T.WATER && m.rail !== undefined && m.rail[ty * m.w + tx] === 1; // railings only stop cars on the ground: a jumping car sails over them
  };
  // what a car stands on: the roof under its middle once it's up there, otherwise the street
  S.carGround = (m, c) => { const h = S.heightAt(m, c.x, c.y), z = c.z || 0; return h > 0 && h <= z + 6 ? h : 0; };
  S.carAir = (m, c) => (c.vz || 0) > 0 || (c.z || 0) > S.carGround(m, c) + 0.5;
  // roof height under a point (0 off buildings); low roofs can be jumped onto
  S.heightAt = (m, x, y) => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    return tx < 0 || ty < 0 || tx >= m.w || ty >= m.h ? 0 : m.heights[ty * m.w + tx];
  };
  S.los = function (m, x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy), n = Math.ceil(d / 12);
    for (let i = 1; i < n; i++) if (S.solid(m, x0 + (dx * i) / n, y0 + (dy * i) / n)) return false;
    return true;
  };
  // z: height of whatever is colliding; buildings lower than z + 6 can be walked over (you're on their roof)
  S.collideCircle = function (m, o, r, z = 0) {
    for (let it = 0; it < 2; it++) {
      const x0 = Math.floor((o.x - r) / TILE), x1 = Math.floor((o.x + r) / TILE);
      const y0 = Math.floor((o.y - r) / TILE), y1 = Math.floor((o.y + r) / TILE);
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        const tt = S.tile(m, tx, ty);
        if (tt === T.WATER ? !(m.rail && m.rail[ty * m.w + tx] && z < 40) : tt !== T.BUILD || m.heights[ty * m.w + tx] <= z + 6) continue;
        const nx = Math.max(tx * TILE, Math.min(o.x, (tx + 1) * TILE));
        const ny = Math.max(ty * TILE, Math.min(o.y, (ty + 1) * TILE));
        const dx = o.x - nx, dy = o.y - ny, d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) { const d = Math.sqrt(d2); o.x += (dx / d) * (r - d); o.y += (dy / d) * (r - d); }
        else {
          const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
          if (Math.abs(o.x - cx) > Math.abs(o.y - cy)) o.x = o.x > cx ? (tx + 1) * TILE + r : tx * TILE - r;
          else o.y = o.y > cy ? (ty + 1) * TILE + r : ty * TILE - r;
        }
      }
    }
  };

  // ---------------------------------------------------------------- ped physics
  S.PED = { r: 9, run: 140, back: 70, turn: 4.2, jump: 285, grav: 950 }; // snappy jump: clears a car's bonnet in a few hundredths of a second
  S.stepPed = function (m, p, k, dt) {
    let vx = 0, vy = 0;
    if (k & K.ABS) {
      const dx = (k & K.RIGHT ? 1 : 0) - (k & K.LEFT ? 1 : 0), dy = (k & K.DOWN ? 1 : 0) - (k & K.UP ? 1 : 0);
      if (dx || dy) {
        const l = Math.hypot(dx, dy);
        p.a = Math.atan2(dy, dx); vx = (dx / l) * S.PED.run; vy = (dy / l) * S.PED.run; p.mv = 1;
      } else p.mv = 0;
    } else {
      const t = (k & K.RIGHT ? 1 : 0) - (k & K.LEFT ? 1 : 0);
      p.a = S.wrapA(p.a + t * S.PED.turn * dt);
      const sp = k & K.UP ? S.PED.run : k & K.DOWN ? -S.PED.back : 0;
      vx = Math.cos(p.a) * sp; vy = Math.sin(p.a) * sp; p.mv = sp ? 1 : 0;
    }
    // jumping: Space on foot. Like GTA2 a jump is always one hop forward in the direction you face.
    // In the air (and when you land on a car and slide across its roof) the arrows steer the hop.
    if (p.z === undefined) { p.z = 0; p.vz = 0; p.jvx = 0; p.jvy = 0; p.sl = 0; }
    const hb = S.heightAt(m, p.x, p.y);
    const gz = Math.max(p.gz || 0, p.z >= hb - 6 ? hb : 0); // car roof (from the server) or building roof
    let air = p.z > gz + 0.5 || p.vz > 0;
    let slide = !air && gz > 0 && p.sl && Math.hypot(p.jvx, p.jvy) > 25;
    if (!air) {
      if (!slide) { p.sl = 0; p.jvx = vx; p.jvy = vy; }
      // a trampoline: on it at street level, you're thrown way up, hopping forward the way you face
      if (gz === 0 && m.tramps && m.tramps.some((t) => Math.abs(t.x - p.x) < S.TRAMP_R && Math.abs(t.y - p.y) < S.TRAMP_R && Math.hypot(t.x - p.x, t.y - p.y) < S.TRAMP_R)) {
        p.vz = S.TRAMP; air = true; slide = false; p.sl = 0; p.tr = 1;
        p.jvx = Math.cos(p.a) * 70; p.jvy = Math.sin(p.a) * 70; // a gentle hop: you come down on a two-tile roof, not past it
      } else if (k & K.HAND) { p.vz = S.PED.jump; air = true; slide = false; p.sl = 0; p.jvx = Math.cos(p.a) * S.PED.run; p.jvy = Math.sin(p.a) * S.PED.run; }
    }
    if (air || slide) {
      const sp = Math.hypot(p.jvx, p.jvy);
      if (sp > 1) {
        const cur = Math.atan2(p.jvy, p.jvx), lim = 5 * dt;
        const nd = cur + Math.max(-lim, Math.min(lim, S.angDiff(p.a, cur)));
        const f = slide ? Math.exp(-2.2 * dt) : 1; // roof slides wear off
        p.jvx = Math.cos(nd) * sp * f; p.jvy = Math.sin(nd) * sp * f;
      }
      vx = p.jvx; vy = p.jvy; p.mv = 0;
    }
    p.z += p.vz * dt; p.vz -= S.PED.grav * dt;
    if (p.z <= gz) { if (air && gz > 0) p.sl = 1; p.z = gz; if (p.vz < 0) p.vz = 0; }
    vx += p.kx; vy += p.ky;
    const f = Math.exp(-6 * dt); p.kx *= f; p.ky *= f;
    if (Math.abs(p.kx) < 1) p.kx = 0; if (Math.abs(p.ky) < 1) p.ky = 0;
    p.x += vx * dt; p.y += vy * dt;
    S.collideCircle(m, p, S.PED.r, p.z);
  };

  // ---------------------------------------------------------------- car physics
  const CP = [[0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5], [0, 0.5], [0, -0.5], [0.5, 0], [-0.5, 0], [0.25, 0.5], [0.25, -0.5], [-0.25, 0.5], [-0.25, -0.5]];
  S.carHits = function (m, c) {
    const C = S.CARS[c.t], ca = Math.cos(c.a), sa = Math.sin(c.a);
    for (const [u, v] of CP) {
      const lx = u * C.len, ly = v * C.wid;
      if (S.wall(m, c.x + lx * ca - ly * sa, c.y + lx * sa + ly * ca, c.z || 0)) return true;
    }
    return false;
  };
  // a car jump goes exactly as high as a jump on foot (up onto a one-storey roof), but floats longer (lighter
  // gravity), so at speed it carries a car clean over another car or across the river
  S.CAR_GRAV = 425;
  S.CAR_JUMP = Math.sqrt(2 * S.CAR_GRAV * (S.PED.jump * S.PED.jump) / (2 * S.PED.grav));
  // helicopters: modes 0 parked, 1 flying, 2 landing, 3 crashing (towards c.crashTo), 4 crashed
  S.HELI_ALT = 250; // cruising height: above every roof
  S.stepHeli = function (m, c, k, dt) {
    const C = S.CARS[c.t], mode = c.hm || 0, ground = S.heightAt(m, c.x, c.y);
    if (mode === 0 || mode === 4) { c.vx = 0; c.vy = 0; c.vz = 0; return 0; }
    let ca = Math.cos(c.a), sa = Math.sin(c.a), vf = c.vx * ca + c.vy * sa, vr = -c.vx * sa + c.vy * ca;
    if (mode === 1) {
      const free = c.z > ground + 18; // clear of the roof before it moves off
      const st = (k & K.RIGHT ? 1 : 0) - (k & K.LEFT ? 1 : 0);
      c.a = S.wrapA(c.a + st * C.turn * dt);
      ca = Math.cos(c.a); sa = Math.sin(c.a); vf = c.vx * ca + c.vy * sa; vr = -c.vx * sa + c.vy * ca;
      if (free && k & K.UP) vf = Math.min(C.max, vf + C.acc * dt);
      else if (free && k & K.DOWN) vf = Math.max(-C.rev, vf - C.acc * dt);
      else vf -= vf * Math.min(1, 0.9 * dt);
      vr -= vr * Math.min(1, C.grip * dt);
      c.z += Math.max(-90 * dt, Math.min(110 * dt, S.HELI_ALT - c.z));
    } else if (mode === 2) {
      vf -= vf * Math.min(1, 2.5 * dt); vr -= vr * Math.min(1, 3 * dt);
      c.z = Math.max(ground, c.z - 85 * dt);
      if (c.z <= ground + 0.01) { c.z = ground; c.hm = 0; vf = 0; vr = 0; }
    } else if (mode === 3) {
      // going down in a spin, aiming for a spot of open street
      c.a = S.wrapA(c.a + 5.5 * dt);
      let near = true;
      if (c.crashTo) {
        const dx = c.crashTo[0] - c.x, dy = c.crashTo[1] - c.y, d = Math.hypot(dx, dy), sp = Math.min(240, d * 2.5);
        near = d < 26;
        c.vx = d > 1 ? (dx / d) * sp : 0; c.vy = d > 1 ? (dy / d) * sp : 0;
      } else { c.vx *= Math.exp(-2 * dt); c.vy *= Math.exp(-2 * dt); }
      c.z = Math.max(near ? 0 : ground + 14, c.z - 120 * dt);
      if (near && c.z <= 0.01) { c.z = 0; c.hm = 4; }
      c.x += c.vx * dt; c.y += c.vy * dt;
      return 0;
    }
    c.vx = vf * ca - vr * sa; c.vy = vf * sa + vr * ca;
    c.x = Math.max(TILE, Math.min(m.w * TILE - TILE, c.x + c.vx * dt));
    c.y = Math.max(TILE, Math.min(m.h * TILE - TILE, c.y + c.vy * dt));
    return 0;
  };
  S.stepCar = function (m, c, k, dt) {
    if (c.t === S.HELI) return S.stepHeli(m, c, k, dt);
    const C = S.carStats(c);
    // in the air (car jump): no grip and no steering, gravity like a person's jump
    if (S.carAir(m, c)) {
      c.vz -= S.CAR_GRAV * dt; c.z += c.vz * dt;
      const g = S.carGround(m, c);
      if (c.z <= g) { c.z = g; c.vz = 0; } // landed: on the street, or on a low roof
      c.a = S.wrapA(c.a + (c.spin || 0) * dt);
      let impact = 0;
      c.x += c.vx * dt;
      if (S.carHits(m, c)) { c.x -= c.vx * dt; impact = Math.abs(c.vx); c.vx *= -0.3; }
      c.y += c.vy * dt;
      if (S.carHits(m, c)) { c.y -= c.vy * dt; impact = Math.max(impact, Math.abs(c.vy)); c.vy *= -0.3; }
      return impact;
    }
    const drive = !c.dead && c.drv;
    const stuck = S.carHits(m, c);
    let ca = Math.cos(c.a), sa = Math.sin(c.a);
    let vf = c.vx * ca + c.vy * sa;
    const st = drive ? (k & K.RIGHT ? 1 : 0) - (k & K.LEFT ? 1 : 0) : 0;
    const hb = drive && k & K.HAND;
    const sf = Math.max(-1, Math.min(1, vf / 120));
    const oa = c.a;
    c.a = S.wrapA(c.a + (st * C.turn * (hb ? 1.4 : 1) * sf + (c.spin || 0)) * dt);
    if (c.spin) { c.spin *= Math.exp(-3 * dt); if (Math.abs(c.spin) < 0.05) c.spin = 0; }
    if (!stuck && S.carHits(m, c)) c.a = oa;
    ca = Math.cos(c.a); sa = Math.sin(c.a);
    vf = c.vx * ca + c.vy * sa;
    let vr = -c.vx * sa + c.vy * ca;
    if (drive && k & K.UP) {
      if (vf < 0) vf += C.acc * 2.5 * dt;
      else if (vf < C.max) vf = Math.min(C.max, vf + C.acc * dt * Math.max(0.3, 1 - vf / C.max));
    } else if (drive && k & K.DOWN) {
      if (vf > 10) vf -= C.acc * 2.2 * dt;
      else vf = Math.max(-C.rev, vf - C.acc * 0.8 * dt);
    } else {
      vf -= vf * Math.min(1, (c.dead ? 2.5 : 0.6) * dt);
      if (Math.abs(vf) < 4) vf = 0;
    }
    if (hb) vf -= vf * Math.min(1, 1.1 * dt);
    const grip = c.oil > 0 ? 0.35 : hb ? 1.5 : c.dead ? 5 : C.grip;
    vr -= vr * Math.min(1, grip * dt);
    if (c.oil > 0) c.oil = Math.max(0, c.oil - dt);
    c.vx = vf * ca - vr * sa; c.vy = vf * sa + vr * ca;
    let impact = 0;
    c.x += c.vx * dt;
    if (!stuck && S.carHits(m, c)) { c.x -= c.vx * dt; impact = Math.max(impact, Math.abs(c.vx)); c.vx *= -0.3; c.vy *= 0.85; }
    c.y += c.vy * dt;
    if (!stuck && S.carHits(m, c)) { c.y -= c.vy * dt; impact = Math.max(impact, Math.abs(c.vy)); c.vy *= -0.3; c.vx *= 0.85; }
    if (m.rampAt && m.rampAt.size) {
      // the car's nose reaching the top of the ramp launches it
      const L = S.CARS[c.t].len / 2, fx = c.x + Math.cos(c.a) * L, fy = c.y + Math.sin(c.a) * L;
      const tx = Math.floor(fx / TILE), ty = Math.floor(fy / TILE), d = m.rampAt.get(ty * m.w + tx);
      if (d !== undefined) {
        const [ux, uy] = S.DIR4[d], v = c.vx * ux + c.vy * uy;
        const along = ((fx - (tx + 0.5) * TILE) * ux + (fy - (ty + 0.5) * TILE) * uy) / TILE + 0.5; // 0..1 up the ramp
        if (v > 150 && along > 0.72 && !c.ai) { c.vz = Math.min(330, v * 0.75); c.z = (c.z || 0) + 0.01; } // traffic just stops at the barrier
      }
    }
    return impact;
  };
  S.DIR4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  // cars as oriented boxes: exact overlap test (separating axes) with the push-out direction from a to b
  S.carBox = (c) => { const C = S.CARS[c.t]; return { x: c.x, y: c.y, ca: Math.cos(c.a), sa: Math.sin(c.a), hl: C.len / 2, hw: C.wid / 2 }; };
  S.boxOverlap = function (A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    let best = 1e9, nx = 0, ny = 0;
    const axes = [[A.ca, A.sa], [-A.sa, A.ca], [B.ca, B.sa], [-B.sa, B.ca]];
    for (const [ux, uy] of axes) {
      const rA = A.hl * Math.abs(A.ca * ux + A.sa * uy) + A.hw * Math.abs(-A.sa * ux + A.ca * uy);
      const rB = B.hl * Math.abs(B.ca * ux + B.sa * uy) + B.hw * Math.abs(-B.sa * ux + B.ca * uy);
      const d = dx * ux + dy * uy, o = rA + rB - Math.abs(d);
      if (o <= 0) return null;
      if (o < best) { best = o; const sg = d < 0 ? -1 : 1; nx = ux * sg; ny = uy * sg; }
    }
    return { nx, ny, depth: best };
  };
  S.carCircles = function (c) {
    const C = S.CARS[c.t], n = Math.max(2, Math.ceil(C.len / C.wid)), r = C.wid / 2 + 1;
    const sp = (C.len - 2 * r) / (n - 1), ca = Math.cos(c.a), sa = Math.sin(c.a), out = [];
    for (let i = 0; i < n; i++) { const l = -C.len / 2 + r + i * sp; out.push([c.x + ca * l, c.y + sa * l, r]); }
    return out;
  };
  return S;
});
