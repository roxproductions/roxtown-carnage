// RoxTown Carnage — the car fist fight.
// When two players keep stealing the same car from each other, they settle it with their fists: best of three
// rounds in a side-on arena, played like a classic Street Fighter game. Everything runs on 60 frames a second with
// frame data for every move: hitstop on every hit, chains and special cancels, motion-input specials, throws, dashes,
// high/low/overhead blocking, a super meter, and (on the final knockout) a finishing move.
// This is the pure simulation (no I/O). game.js runs it authoritatively; each fighter's page runs it too, replaying
// its own keys, so its moves come out the same frame the key goes down.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shared.js'));
  else factory(root.S);
})(typeof self !== 'undefined' ? self : this, function (S) {
  const K = S.K;
  const F = (S.Fight = {});
  const AW = (F.AW = 640); // arena width in fight units; fighters stand about 150 units tall
  const DTF = 1 / 60;
  F.ROUND_T = 60; // seconds per round
  F.WINS = 2; // round wins needed
  F.DUEL_AT = 3; // the third steal of the same car between the same two players starts a fight
  // the four attack buttons (borrowing the key bits the street game uses for other things)
  const LP = (F.LP = K.FIRE), LK = (F.LK = K.HAND), HP = (F.HP = K.ABS), HK = (F.HK = K.TUR);
  const PB = LP | HP, KB = LK | HK, BTN = PB | KB;
  const PH = (F.PH = { INTRO: 0, FIGHT: 1, KO: 2, FINISH: 3, FATAL: 4, OVER: 5 });
  const A = (F.A = {
    IDLE: 0, WALK: 1, CROUCH: 2, BLOCK: 3, CBLOCK: 4, JUMP: 5,
    LP: 6, HP: 7, LK: 8, HK: 9, CLP: 10, CHP: 11, CLK: 12, CHK: 13, JLP: 14, JHP: 15, JLK: 16, JHK: 17,
    HUBCAP: 18, RISING: 19, SPIN: 20, SUPER: 21, THROW: 22, THROWN: 23,
    HURT: 24, FALL: 25, DOWN: 26, GETUP: 27, DIZZY: 28, WIN: 29, KO: 30, FIN: 31,
    DASH: 32, BDASH: 33, PREJUMP: 34, LAND: 35,
  });
  // Frame data, at 60 frames a second. fs: startup, fa: active, fr: recovery. h: mid / low (block crouching) /
  // over (block standing). hs / bs: hitstun / blockstun. kb: pushback. stop: hitstop. lvl: 0 light (chains),
  // 1 heavy, 2 special, 3 super. cancel: can be cancelled into a special on hit or block. aa: how high off the ground
  // it reaches an airborne opponent. hy: where the hit spark goes.
  const MV = (F.MV = {
    [A.LP]: { fs: 3, fa: 2, fr: 7, dmg: 5, reach: 74, hs: 16, bs: 10, kb: 150, stop: 7, lvl: 0, cancel: 1, aa: 60, hy: 122 },
    [A.HP]: { fs: 6, fa: 3, fr: 17, dmg: 12, reach: 94, hs: 21, bs: 15, kb: 240, stop: 11, lvl: 1, cancel: 1, aa: 70, hy: 120 },
    [A.LK]: { fs: 4, fa: 3, fr: 9, dmg: 6, reach: 88, hs: 16, bs: 11, kb: 170, stop: 7, lvl: 0, cancel: 1, aa: 50, hy: 82 },
    [A.HK]: { fs: 9, fa: 4, fr: 19, dmg: 13, reach: 112, hs: 22, bs: 15, kb: 290, stop: 12, lvl: 1, aa: 90, hy: 112 },
    [A.CLP]: { fs: 3, fa: 2, fr: 6, dmg: 4, reach: 72, hs: 15, bs: 9, kb: 130, stop: 6, lvl: 0, cancel: 1, aa: 30, hy: 74 },
    [A.CHP]: { fs: 5, fa: 5, fr: 19, dmg: 12, reach: 74, hs: 21, bs: 14, kb: 200, stop: 11, lvl: 1, cancel: 1, aa: 175, hy: 135, name: 0 },
    [A.CLK]: { fs: 4, fa: 3, fr: 8, dmg: 5, reach: 92, h: 'low', hs: 17, bs: 10, kb: 150, stop: 6, lvl: 0, cancel: 1, aa: 0, hy: 16 },
    [A.CHK]: { fs: 7, fa: 5, fr: 24, dmg: 11, reach: 116, h: 'low', down: 1, lift: 200, bs: 14, kb: 160, stop: 11, lvl: 1, aa: 0, hy: 16 },
    [A.JLP]: { fs: 3, fa: 8, fr: 0, dmg: 6, reach: 76, h: 'over', hs: 16, bs: 10, kb: 150, stop: 8, lvl: 0, air: 1, hy: 125 },
    [A.JHP]: { fs: 6, fa: 6, fr: 0, dmg: 12, reach: 90, h: 'over', hs: 21, bs: 14, kb: 210, stop: 11, lvl: 1, air: 1, hy: 120 },
    [A.JLK]: { fs: 4, fa: 10, fr: 0, dmg: 7, reach: 86, h: 'over', hs: 16, bs: 10, kb: 160, stop: 8, lvl: 0, air: 1, hy: 100 },
    [A.JHK]: { fs: 7, fa: 6, fr: 0, dmg: 13, reach: 102, h: 'over', hs: 22, bs: 15, kb: 230, stop: 12, lvl: 1, air: 1, hy: 100 },
    [A.HUBCAP]: { fs: 10, fa: 2, fr: 24, lvl: 2, name: 'HUBCAP TOSS' },
    [A.RISING]: { fs: 3, fa: 12, fr: 0, dmg: 15, reach: 70, aa: 240, down: 1, lift: 640, kb: 200, bs: 16, stop: 13, lvl: 2, hy: 140, name: 'RISING FIST' },
    [A.SPIN]: { fs: 6, fa: 30, fr: 12, dmg: 6, reach: 86, aa: 80, hs: 18, bs: 12, kb: 120, stop: 7, lvl: 2, hy: 110, name: 'TIRE SPIN KICK' },
    [A.SUPER]: { fs: 6, fa: 24, fr: 24, dmg: 6, reach: 72, aa: 60, hs: 30, bs: 14, kb: 60, stop: 6, lvl: 3, hy: 115, name: 'CARJACK RUSH' },
    [A.THROW]: { fs: 3, fa: 1, fr: 30, reach: 78, lvl: 1 },
  });
  for (const m of Object.values(MV)) { m.s = m.fs / 60; m.a = m.fa / 60; m.r = m.fr / 60; } // in seconds, for drawing
  const HUB = [{ dmg: 9, h: 'mid', hs: 20, bs: 14, kb: 200, stop: 9, lvl: 2, speed: 300 }, { dmg: 11, h: 'mid', hs: 22, bs: 15, kb: 230, stop: 10, lvl: 2, speed: 470 }];
  const THROWMV = { dmg: 16, down: 1, lift: 560, kb: 560, stop: 14, lvl: 1 }; // released hard: they sail most of the way across the arena
  const GRABF = 20; // frames from grab to release
  const RUSHMV = { dmg: 5, hs: 34, kb: 30, stop: 4, lvl: 3 }, RUSHEND = { dmg: 12, down: 1, lift: 600, kb: 320, stop: 24, lvl: 3 };
  F.DMG = 1;
  F.COMBOS = ['', 'STREET COMBO', 'CARJACKER COMBO', 'ROAD RAGE'];
  F.FATALS = ['', 'CAR CRUSH', 'SKY HIGH', 'FIRE STARTER'];
  F.FATAL_T = 3.4;
  const GRAV = 2000, JUMP_V = 690, WALK_F = 175, WALK_B = 140;
  const KBG = Math.exp(-10 / 60), KBA = Math.exp(-2 / 60);

  // every number a fighter or a fight carries (all plain numbers, so the state saves and loads exactly)
  const FK = ['x', 'y', 'vx', 'vy', 'kbx', 'face', 'hp', 'act', 'at', 'fr', 'air', 'jk', 'hitDone', 'conn', 'stun', 'combo', 'cn', 'lastHit', 'taken',
    'meter', 'hits', 'inv', 'str', 'pk', 'dir', 'bufB', 'bufF', 'bufD', 'dq', 'jdir', 'lag', 'grab', 'back', 'rush', 'rf', 'pOn', 'px', 'pvx', 'pstr'];
  const DK = ['ph', 't', 'clock', 'af', 'round', 'rt', 'win', 'rw', 'fk', 'flaw', 'res', 'hs', 'frz', 'sf', 'done', 'w0', 'w1', 'lh0', 'lh1', 'lh2', 'lh3'];

  function fighter(x, face, meter) {
    const f = { dirs: [] };
    for (const k of FK) f[k] = 0;
    Object.assign(f, { x, face, hp: 100, act: A.IDLE, dir: 5, lastHit: -999, meter: meter || 0 });
    return f;
  }
  F.create = function (id) {
    const d = { id };
    for (const k of DK) d[k] = 0;
    Object.assign(d, { round: 1, rt: F.ROUND_T, win: -1, rw: -1, lh0: -1 });
    d.wins = [0, 0]; d.lh = [-1, 0, 0, 0];
    d.f = [fighter(0, 1), fighter(0, -1)];
    resetRound(d);
    return d;
  };
  function resetRound(d) {
    d.f = [fighter(AW / 2 - 120, 1, d.f[0].meter), fighter(AW / 2 + 120, -1, d.f[1].meter)];
    d.rt = F.ROUND_T; d.ph = PH.INTRO; d.t = 0; d.rw = -1; d.flaw = 0; d.frz = 0; d.sf = 0;
  }
  F.wins = (d) => [d.w0, d.w1];

  const isNeutral = (f) => f.act === A.IDLE || f.act === A.WALK || f.act === A.CROUCH || ((f.act === A.BLOCK || f.act === A.CBLOCK) && f.stun <= 0);
  const untouchable = (f) => f.inv > 0 || f.act === A.DOWN || f.act === A.GETUP || f.act === A.KO || f.act === A.FALL || f.act === A.THROWN;
  // which way a fighter is holding, in numpad notation relative to the way they face (6 = forward, 2 = down...)
  function dirOf(f, k) {
    const fw = f.face > 0 ? K.RIGHT : K.LEFT, bk = f.face > 0 ? K.LEFT : K.RIGHT;
    const h = k & fw && !(k & bk) ? 1 : k & bk && !(k & fw) ? -1 : 0, v = k & K.UP && !(k & K.DOWN) ? 3 : k & K.DOWN && !(k & K.UP) ? -3 : 0;
    return 5 + h + v;
  }
  // a motion (like 2 3 6) done within the last n frames, ending at the direction held now
  function motion(d, f, seq, n) {
    let j = seq.length - 1;
    for (let i = f.dirs.length - 1; i >= 0 && j >= 0; i--) {
      const [dr, t] = f.dirs[i];
      if (d.af - t > n) break;
      if (dr === seq[j]) j--;
    }
    return j < 0;
  }
  function threat(d, i) {
    const o = d.f[1 - i], f = d.f[i];
    if (o.pOn && Math.sign(f.x - o.px) === Math.sign(o.pvx) && Math.abs(f.x - o.px) < 240) return true;
    const mv = MV[o.act];
    return !!(mv && mv.dmg && Math.abs(o.x - f.x) < 200 && o.fr < mv.fs + mv.fa);
  }

  // ---------------------------------------------------------------- input
  function input(d, i, k, live) {
    const f = d.f[i];
    const prev = f.pk; f.pk = k;
    if (!live) { f.bufB = 0; f.dq = 0; return; }
    const dr = dirOf(f, k);
    if (dr !== f.dir) {
      f.dir = dr; f.dirs.push([dr, d.af]);
      if (f.dirs.length > 16) f.dirs.shift();
      // a quick double tap forward or back: a dash
      const n = f.dirs.length;
      if ((dr === 6 || dr === 4) && n >= 3 && f.dirs[n - 2][0] === 5 && f.dirs[n - 3][0] === dr && d.af - f.dirs[n - 3][1] <= 14) f.dq = dr === 6 ? 1 : -1;
    }
    const pressed = k & ~prev & BTN;
    if (pressed) { f.bufB = (d.af - f.bufF <= 2 ? f.bufB : 0) | pressed; f.bufF = d.af; f.bufD = dr; } // with the direction held as it went down // two buttons a frame or two apart count as together
    if (f.bufB && d.af - f.bufF > 7) f.bufB = 0; // a press waits up to 7 frames for its chance (so it comes out the moment you can act)
    if (f.dq && (!f.dirs.length || d.af - f.dirs[f.dirs.length - 1][1] > 6)) f.dq = 0;
  }
  function begin(f, act, str) {
    f.act = act; f.fr = 0; f.at = 0; f.hitDone = 0; f.conn = 0; f.hits = 0; f.str = str | 0; f.grab = 0; f.rush = 0; f.rf = 0;
    if (!f.air) f.vx = 0;
  }
  const throwable = (o) => !o.air && o.inv <= 0 && !untouchable(o) && o.act !== A.HURT && !((o.act === A.BLOCK || o.act === A.CBLOCK) && o.stun > 0) && o.act !== A.DIZZY;
  function tryAct(d, i) {
    const f = d.f[i], o = d.f[1 - i], b = f.bufB;
    if (d.ph === PH.FINISH && i === d.win && b) {
      const dist = Math.abs(o.x - f.x);
      let fk = 0;
      if (b & KB && motion(d, f, [4, 5, 4], 30)) fk = 1;
      else if (b & PB && motion(d, f, [2, 8], 30) && dist < 150) fk = 2;
      else if (b & PB && motion(d, f, [6, 4, 6], 40) && dist < 290) fk = 3;
      if (fk) { f.bufB = 0; d.fk = fk; d.ph = PH.FATAL; d.t = 0; f.act = A.FIN; f.at = 0; f.fr = 0; f.vx = 0; f.kbx = 0; f.air = 0; f.y = 0; f.vy = 0; return; }
    }
    const mv = MV[f.act], neutral = isNeutral(f) && !f.air;
    // a dash
    if (f.dq && neutral && d.ph === PH.FIGHT) { begin(f, f.dq > 0 ? A.DASH : A.BDASH); if (f.dq < 0) f.inv = 7; f.dq = 0; f.bufB = 0; return; }
    if (!b) return;
    if (f.air) {
      if (f.act !== A.JUMP || f.jk) return;
      f.jk = 1; f.bufB = 0;
      begin(f, b & HP ? A.JHP : b & HK ? A.JHK : b & LP ? A.JLP : A.JLK);
      return;
    }
    const canCancel = mv && mv.cancel && f.conn && f.fr <= mv.fs + mv.fa + 10;
    const canChain = canCancel && mv.lvl === 0 && f.fr >= mv.fs;
    if (!neutral && !canCancel) return; // stays buffered: comes out the first frame you can move
    const P = b & PB, Kk = b & KB, dr = f.bufD || f.dir, str = b & (HP | HK) ? 1 : 0;
    // specials first (the super, then the uppercut, the hubcap, the spin kick), from standing or cancelled out of a hit
    if (P && f.meter >= 100 && (dr === 6 || dr === 3) && (motion(d, f, [2, 3, 6, 2, 3, 6], 36) || motion(d, f, [2, 3, 6, 3, 6], 36))) {
      f.bufB = 0; begin(f, A.SUPER, 1); f.meter -= 100; f.inv = MV[A.SUPER].fs + MV[A.SUPER].fa; d.frz = 30; d.sf = i + 1; return;
    }
    if (P && dr === 3 && motion(d, f, [6, 2, 3], 16)) {
      f.bufB = 0; begin(f, A.RISING, str); f.inv = str ? 9 : 5; f.air = 1; f.vy = str ? 760 : 620; f.vx = f.face * (str ? 110 : 70); return;
    }
    if (P && dr === 6 && !f.pOn && motion(d, f, [2, 3, 6], 16)) { f.bufB = 0; begin(f, A.HUBCAP, str); return; }
    if (Kk && dr === 4 && motion(d, f, [2, 1, 4], 16)) { f.bufB = 0; begin(f, A.SPIN, str); return; }
    if (!neutral && !canChain) return;
    // a throw: close in, heavy punch towards or away from them (or light punch + light kick together)
    if (neutral && Math.abs(o.x - f.x) < MV[A.THROW].reach && throwable(o) && d.ph === PH.FIGHT && ((b & HP && (dr === 6 || dr === 4)) || (b & (LP | LK)) === (LP | LK))) {
      f.bufB = 0; begin(f, A.THROW); f.back = dr === 4 ? 1 : 0; return;
    }
    // normals: crouching if holding down
    const cr = dr <= 3;
    const act = b & HP ? (cr ? A.CHP : A.HP) : b & HK ? (cr ? A.CHK : A.HK) : b & LP ? (cr ? A.CLP : A.LP) : cr ? A.CLK : A.LK;
    f.bufB = 0;
    begin(f, act);
  }

  // ---------------------------------------------------------------- hits
  function push(d, i, o, dir, kb, proj) {
    o.kbx = dir * kb;
    const f = d.f[i];
    if (!proj && !f.air && ((o.x < 46 && dir < 0) || (o.x > AW - 46 && dir > 0))) f.kbx = -dir * kb * 0.85; // up against the wall: the attacker gets pushed back instead
  }
  // returns true if it hit, false if it was blocked
  function hit(d, i, mv, act, srcX) {
    const f = d.f[i], o = d.f[1 - i];
    const dir = o.x >= srcX ? 1 : -1;
    const awayK = dir > 0 ? K.RIGHT : K.LEFT, towardK = dir > 0 ? K.LEFT : K.RIGHT;
    const holdBack = (o.pk & awayK) && !(o.pk & towardK), crouching = !!(o.pk & K.DOWN) && !(o.pk & K.UP);
    const canBlock = !o.air && (isNeutral(o) || o.act === A.BLOCK || o.act === A.CBLOCK) && d.ph === PH.FIGHT;
    const blocked = canBlock && holdBack && (mv.h === 'low' ? crouching : mv.h === 'over' ? !crouching : true);
    d.hs++;
    if (blocked) {
      const chip = mv.lvl >= 2 ? mv.dmg * 0.2 : 0;
      o.hp = Math.max(1, o.hp - chip); o.taken += chip;
      o.act = crouching ? A.CBLOCK : A.BLOCK; o.fr = 0; o.at = 0; o.stun = mv.bs || 12; o.vx = 0;
      push(d, i, o, dir, (mv.kb || 150) * 0.9, srcX !== f.x);
      f.meter = Math.min(100, f.meter + 2); o.meter = Math.min(100, o.meter + 1);
      d.frz = Math.max(d.frz, (mv.stop || 8) - 2);
      d.lh0 = 1 - i; d.lh1 = Math.round(chip); d.lh2 = 1; d.lh3 = act;
      f.combo = 0;
      return false;
    }
    const chain = (o.act === A.HURT || o.act === A.FALL || o.act === A.THROWN) && d.af - f.lastHit < 100;
    f.combo = chain ? f.combo + 1 : 1;
    if (!chain) f.cn = 0;
    f.lastHit = d.af;
    const dmg = mv.dmg * F.DMG * Math.max(0.4, 1 - 0.1 * (f.combo - 1)); // later hits of a combo do less
    o.hp = Math.max(0, o.hp - dmg); o.taken += dmg;
    f.meter = Math.min(100, f.meter + mv.dmg * 1.1 + 2); o.meter = Math.min(100, o.meter + mv.dmg * 0.5);
    const cn = f.combo >= 8 ? 3 : f.combo >= 6 ? 2 : f.combo >= 4 ? 1 : 0;
    if (cn > f.cn) f.cn = cn;
    d.lh0 = 1 - i; d.lh1 = Math.round(dmg); d.lh2 = 0; d.lh3 = act;
    d.frz = Math.max(d.frz, mv.stop || 10);
    o.vx = 0;
    if (o.act === A.DIZZY) {
      // the beaten fighter goes down: no finishing move this time
      o.act = A.FALL; o.fr = 0; o.at = 0; o.air = 1; o.vy = 420; o.kbx = dir * 260;
      d.res = 1; d.ph = PH.OVER; d.t = 0;
      return true;
    }
    if (mv.down || o.air || o.hp <= 0) {
      o.act = A.FALL; o.fr = 0; o.at = 0; o.air = 1; o.stun = 0; o.vy = Math.max(mv.lift || 0, o.hp <= 0 ? 460 : 340); o.kbx = dir * Math.max(mv.kb || 0, 200);
    } else {
      o.act = A.HURT; o.fr = 0; o.at = 0; o.stun = mv.hs || 16;
      push(d, i, o, dir, mv.kb || 150, srcX !== f.x);
    }
    if (o.hp <= 0) { d.frz = 42; ko(d, i); }
    return true;
  }
  function ko(d, wi) {
    const w = d.f[wi], l = d.f[1 - wi];
    if (wi) d.w1++; else d.w0++;
    d.rw = wi; d.flaw = w.taken < 0.5 ? 1 : 0;
    w.pOn = 0; l.pOn = 0;
    if ((wi ? d.w1 : d.w0) >= F.WINS) {
      // final knockout: the loser staggers back up, dazed, and the winner gets the chance to finish it
      d.win = wi; d.ph = PH.FINISH; d.t = 0;
      l.act = A.DIZZY; l.fr = 0; l.at = 0; l.air = 0; l.y = 0; l.vy = 0; l.hp = 0; l.kbx = 0;
    } else { d.ph = PH.KO; d.t = 0; }
  }
  function checkHit(d, i) {
    const f = d.f[i], o = d.f[1 - i], mv = MV[f.act];
    if (!mv || !mv.dmg || f.hitDone || f.rush) return;
    if (f.fr < mv.fs || f.fr >= mv.fs + mv.fa) return;
    if (untouchable(o)) return;
    const dx = (o.x - f.x) * f.face;
    if (dx < -8 || dx > mv.reach) return;
    if (mv.air) { if (f.y > 126 || Math.abs(o.y - f.y) > 95) return; }
    else if (o.y > (mv.aa || 40) + (f.y || 0)) return;
    f.hitDone = 1; f.conn = 1;
    const landed = hit(d, i, mv, f.act, f.x);
    if (f.act === A.SUPER) {
      f.vx = 0;
      if (landed && o.hp > 0) { f.rush = 1; f.rf = 0; f.hits = 1; } // locked in: the rush plays out
      else f.fr = mv.fs + mv.fa; // blocked: straight into recovery
    }
  }

  // ---------------------------------------------------------------- per-fighter update
  function update(d, i, live) {
    const f = d.f[i], o = d.f[1 - i];
    f.fr++; f.at += DTF;
    if (f.inv > 0) f.inv--;
    if (f.stun > 0) {
      f.stun--;
      if (f.stun <= 0 && (f.act === A.HURT || f.act === A.BLOCK || f.act === A.CBLOCK)) { f.act = A.IDLE; f.fr = 0; f.at = 0; }
    }
    if (live) tryAct(d, i);
    // standing about: walk, crouch, guard, jump
    if (!f.air && isNeutral(f)) {
      if (o.act !== A.THROWN && !o.air) f.face = o.x >= f.x ? 1 : -1;
      const dr = live ? dirOf(f, f.pk) : 5;
      let act = A.IDLE, vx = 0;
      if (dr >= 7 && d.ph === PH.FIGHT) { begin(f, A.PREJUMP); f.jdir = dr === 9 ? 1 : dr === 7 ? -1 : 0; }
      else {
        if (dr <= 3) act = dr === 1 && threat(d, i) ? A.CBLOCK : A.CROUCH;
        else if (dr === 6) { act = A.WALK; vx = WALK_F * f.face; }
        else if (dr === 4) { if (threat(d, i)) act = A.BLOCK; else { act = A.WALK; vx = -WALK_B * f.face; } }
        if (f.act !== act) { f.act = act; f.fr = 0; f.at = 0; }
        f.vx = vx;
      }
    }
    const mv = MV[f.act];
    switch (f.act) {
      case A.PREJUMP:
        if (f.fr >= 4) { f.act = A.JUMP; f.fr = 0; f.at = 0; f.air = 1; f.jk = 0; f.vy = JUMP_V; f.vx = f.jdir * 205 * f.face; }
        break;
      case A.DASH: f.vx = f.fr < 13 ? 330 * f.face : 0; if (f.fr >= 18) { f.act = A.IDLE; f.fr = 0; } break;
      case A.BDASH: f.vx = f.fr < 12 ? -330 * f.face : 0; if (f.fr >= 21) { f.act = A.IDLE; f.fr = 0; } break;
      case A.LAND: if (f.fr >= f.lag) { f.act = A.IDLE; f.fr = 0; f.at = 0; } break;
      case A.GETUP: if (f.fr >= 14) { f.act = A.IDLE; f.fr = 0; f.at = 0; } break;
      case A.DOWN:
        f.vx = 0;
        if (f.fr >= 32) { if (f.hp > 0) { f.act = A.GETUP; f.fr = 0; f.at = 0; f.inv = 16; } else { f.act = A.KO; f.fr = 0; f.at = 0; } }
        break;
      case A.THROW:
        if (f.fr === mv.fs) {
          if (Math.abs(o.x - f.x) < mv.reach && throwable(o)) { f.grab = 1; o.act = A.THROWN; o.fr = 0; o.at = 0; o.vx = 0; o.kbx = 0; o.pOn = o.pOn; }
        }
        if (f.grab) {
          // the victim is hauled up off their feet and swung along a curve: up onto the shoulder and flung out in
          // front, or (back throw) right over the thrower's head and slammed down behind
          const k = Math.min(1, (f.fr - mv.fs) / GRABF), e = k * k * (3 - 2 * k);
          const P0 = [44, 8], P1 = f.back ? [0, 230] : [-6, 190], P2 = f.back ? [-66, 70] : [72, 92];
          const bx = (1 - e) * (1 - e) * P0[0] + 2 * (1 - e) * e * P1[0] + e * e * P2[0];
          const by = (1 - e) * (1 - e) * P0[1] + 2 * (1 - e) * e * P1[1] + e * e * P2[1];
          o.x = Math.max(30, Math.min(AW - 30, f.x + f.face * bx)); o.y = by; o.jk = f.back ? 2 : 1;
          if (f.fr === mv.fs + GRABF) {
            f.grab = 0; o.jk = 0;
            hit(d, i, THROWMV, A.THROW, f.x); // flies off (FALL, in the air from this height), lands hard (DOWN)
            if (f.back) f.face = -f.face;
          }
        }
        if (f.fr >= mv.fs + mv.fa + mv.fr) { f.act = A.IDLE; f.fr = 0; f.at = 0; }
        break;
      case A.HUBCAP:
        if (f.fr === mv.fs) { const h = HUB[f.str]; f.pOn = 1; f.pstr = f.str; f.px = f.x + f.face * 44; f.pvx = h.speed * f.face; }
        if (f.fr >= mv.fs + mv.fa + mv.fr) { f.act = A.IDLE; f.fr = 0; f.at = 0; }
        break;
      case A.RISING:
        checkHit(d, i);
        break; // ends when it lands
      case A.SPIN:
        if (f.fr >= mv.fs && f.fr < mv.fs + (f.str ? mv.fa : 20)) {
          f.vx = (f.str ? 250 : 200) * f.face; f.y = 26;
          if ((f.fr - mv.fs) % 9 === 0 && f.hits < (f.str ? 3 : 2)) { f.hitDone = 0; }
          if (!f.hitDone) {
            const before = d.hs;
            checkHit(d, i);
            if (d.hs !== before) f.hits++;
          }
        } else if (f.fr >= mv.fs) { f.vx = 0; f.y = 0; if (f.fr >= mv.fs + mv.fa + mv.fr) { f.act = A.IDLE; f.fr = 0; f.at = 0; } }
        break;
      case A.SUPER:
        if (f.rush) {
          // the rush: a flurry of blows, then one that sends them flying
          f.rf++; f.vx = 0;
          o.x = f.x + f.face * 62; o.stun = 30;
          if (f.rf % 6 === 0) {
            if (f.hits < 6) { hit(d, i, RUSHMV, A.SUPER, f.x); f.hits++; }
            else { hit(d, i, RUSHEND, A.SUPER, f.x); f.rush = 0; f.fr = mv.fs + mv.fa; }
          }
        } else {
          if (f.fr >= mv.fs && f.fr < mv.fs + mv.fa) f.vx = 470 * f.face; else f.vx = 0;
          checkHit(d, i);
          if (!f.rush && f.fr >= mv.fs + mv.fa + mv.fr) { f.act = A.IDLE; f.fr = 0; f.at = 0; }
        }
        break;
      default:
        if (mv && mv.dmg) {
          checkHit(d, i);
          if (mv.air) { if (f.fr >= mv.fs + mv.fa) { f.act = A.JUMP; } } // the pose holds till you land; no second attack
          else if (f.fr >= mv.fs + mv.fa + mv.fr) { f.act = A.IDLE; f.fr = 0; f.at = 0; }
        }
    }
    // physics
    if (f.air && f.act !== A.THROWN) {
      f.vy -= GRAV * DTF; f.y += f.vy * DTF;
      if (f.y <= 0 && f.vy <= 0) {
        f.y = 0; f.vy = 0; f.air = 0;
        if (f.act === A.FALL) { f.act = A.DOWN; f.fr = 0; f.at = 0; }
        else if (f.act === A.RISING) { f.act = A.LAND; f.lag = f.str ? 16 : 11; f.fr = 0; f.at = 0; f.vx = 0; }
        else if (f.act !== A.HURT) { f.act = A.LAND; f.lag = 3; f.fr = 0; f.at = 0; f.vx = 0; }
      }
    }
    if (f.act === A.FIN || f.act === A.DIZZY || f.act === A.KO || f.act === A.DOWN || f.act === A.HURT || f.act === A.BLOCK || f.act === A.CBLOCK || f.act === A.THROWN || f.act === A.LAND || f.act === A.GETUP) f.vx = 0;
    if (f.act !== A.THROWN) {
      f.x += (f.vx + f.kbx) * DTF;
      f.kbx *= f.air ? KBA : KBG;
      if (Math.abs(f.kbx) < 1) f.kbx = 0;
    }
    if (f.x < 30) { f.x = 30; f.kbx = 0; }
    if (f.x > AW - 30) { f.x = AW - 30; f.kbx = 0; }
    // the hubcap in flight
    if (f.pOn) {
      f.px += f.pvx * DTF;
      if (f.px < -40 || f.px > AW + 40) f.pOn = 0;
      else if (!untouchable(o) && Math.abs(o.x - f.px) < 30 && o.y < 125) { const sx = f.px; f.pOn = 0; hit(d, i, HUB[f.pstr], A.HUBCAP, sx - Math.sign(f.pvx)); }
    }
  }
  function separate(d) {
    const [a, b] = d.f;
    if (Math.abs(a.y - b.y) > 70) return;
    const lying = (f) => f.act === A.KO || f.act === A.DOWN || f.act === A.THROWN || f.act === A.FALL;
    if (lying(a) || lying(b)) return;
    const dx = b.x - a.x, min = 44;
    if (Math.abs(dx) < min) {
      const s = dx > 0 ? 1 : dx < 0 ? -1 : a.face;
      const push = (min - Math.abs(dx)) / 2;
      a.x -= push * s; b.x += push * s;
      for (const [p, q] of [[a, b], [b, a]]) { if (p.x < 30) { q.x += 30 - p.x; p.x = 30; } if (p.x > AW - 30) { q.x -= p.x - (AW - 30); p.x = AW - 30; } }
    }
  }

  // ---------------------------------------------------------------- the fight's state machine
  // keys: [fighter 0 keys, fighter 1 keys] (the usual K bitmask: arrows, and LP / HP / LK / HK above)
  // every number rounded to a thousandth after each step, so a state sent over the network (F.save) is exact and
  // a fighter's page that replays the same keys gets bit-for-bit the same fight as the game
  const q = (v) => Math.round(v * 1000) / 1000;
  function quant(d) {
    for (const k of DK) d[k] = q(d[k]);
    for (const f of d.f) {
      for (const k of FK) f[k] = q(f[k]);
      while (f.dirs.length && d.af - f.dirs[0][1] > 60) f.dirs.shift(); // older directions never matter
    }
    d.wins = [d.w0, d.w1]; d.lh = [d.lh0, d.lh1, d.lh2, d.lh3];
  }
  F.step = function (d, keys) {
    if (d.done) return;
    stepInner(d, keys);
    quant(d);
  };
  function stepInner(d, keys) {
    d.clock += DTF;
    const live0 = d.ph === PH.FIGHT || (d.ph === PH.FINISH && d.win === 0);
    const live1 = d.ph === PH.FIGHT || (d.ph === PH.FINISH && d.win === 1);
    input(d, 0, keys[0] | 0, live0);
    input(d, 1, keys[1] | 0, live1);
    // hitstop: on a hit, everything holds still for a few frames (that's the crunch); keys still go into the buffer
    if (d.frz > 0) { d.frz--; if (!d.frz) d.sf = 0; return; }
    d.af++; d.t += DTF;
    if (d.ph !== PH.FATAL) {
      update(d, 0, live0);
      update(d, 1, live1);
      separate(d);
      // two hubcaps meet in the air: both drop
      const [a, b] = d.f;
      if (a.pOn && b.pOn && Math.abs(a.px - b.px) < 28) { a.pOn = 0; b.pOn = 0; d.hs++; d.lh0 = 2; d.lh1 = 0; d.lh2 = 1; d.lh3 = A.HUBCAP; }
    }
    switch (d.ph) {
      case PH.INTRO:
        if (d.t >= 2.1) { d.ph = PH.FIGHT; d.t = 0; }
        break;
      case PH.FIGHT:
        d.rt -= DTF;
        if (d.rt <= 0) {
          d.rt = 0;
          const [a, b] = d.f;
          if (Math.abs(a.hp - b.hp) < 0.5) { d.rw = -1; d.ph = PH.KO; d.t = 0; } // a draw: the round is replayed
          else {
            const wi = a.hp > b.hp ? 0 : 1, l = d.f[1 - wi];
            l.hp = 0; l.act = A.FALL; l.fr = 0; l.at = 0; l.air = 1; l.vy = 300;
            ko(d, wi);
          }
        }
        break;
      case PH.KO: {
        const w = d.rw >= 0 ? d.f[d.rw] : null;
        if (w && d.t > 1.2 && isNeutral(w) && !w.air) { w.act = A.WIN; w.fr = 0; w.at = 0; }
        if (d.t >= 3.4) {
          d.round++;
          if (d.round > 7) { d.win = d.w0 >= d.w1 ? 0 : 1; d.res = 1; d.ph = PH.OVER; d.t = 0; break; }
          resetRound(d);
        }
        break;
      }
      case PH.FINISH:
        if (d.t >= 7) {
          const l = d.f[1 - d.win];
          l.act = A.FALL; l.fr = 0; l.at = 0; l.air = 1; l.vy = 200;
          d.res = 1; d.ph = PH.OVER; d.t = 0;
        }
        break;
      case PH.FATAL:
        if (d.t >= F.FATAL_T) { d.res = 2; d.ph = PH.OVER; d.t = 0; d.f[d.win].act = A.WIN; d.f[d.win].at = 0; }
        break;
      case PH.OVER: {
        const w = d.f[d.win];
        if (d.t > 0.8 && w.act !== A.WIN && isNeutral(w)) { w.act = A.WIN; w.fr = 0; w.at = 0; }
        if (d.t >= 2.8) d.done = 1;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- bot fighter
  // Returns the key bitmask a bot presses this frame. mem is the bot's own scratch object; skill 1-5.
  // It fights like a person at a cabinet: pokes and sweeps, hubcaps from far away, jump-ins, anti-air uppercuts,
  // blocks (more often the better it is), throws up close, and the odd combo into a special.
  F.bot = function (d, i, mem, rnd, skill) {
    const f = d.f[i], o = d.f[1 - i];
    const sk = Math.max(1, Math.min(5, skill || 3)) - 1;
    const fwd = f.face > 0 ? K.RIGHT : K.LEFT, back = f.face > 0 ? K.LEFT : K.RIGHT, D = K.DOWN;
    const plan = (steps) => { mem.seq = []; for (const [k, n] of steps) for (let j = 0; j < n; j++) mem.seq.push(k); };
    const QCF = (btn) => [[D, 2], [D | fwd, 2], [fwd | btn, 2], [0, 2]];
    const DPm = (btn) => [[fwd, 2], [D, 2], [D | fwd | btn, 2], [0, 2]];
    const QCB = (btn) => [[D, 2], [D | back, 2], [back | btn, 2], [0, 2]];
    if (d.ph !== mem.ph) { mem.ph = d.ph; mem.seq = null; mem.wait = 30 + ((rnd() * 40) | 0); mem.hold = 0; mem.holdT = 0; mem.pick = 0; }
    if (mem.seq && mem.seq.length) return mem.seq.shift();
    const dist = Math.abs(o.x - f.x);
    if (d.ph === PH.FINISH) {
      if (i !== d.win) return 0;
      if (mem.wait-- > 0) return 0;
      if (!mem.pick) mem.pick = 1 + Math.floor(rnd() * 3);
      if (mem.pick === 2 && dist > 120) return fwd;
      if (mem.pick === 3 && dist > 250) return fwd;
      if (mem.pick === 1) plan([[back, 2], [0, 2], [back, 2], [back | LK, 2], [0, 2]]);
      else if (mem.pick === 2) plan([[D, 3], [0, 1], [K.UP, 1], [K.UP | LP, 2], [0, 2]]);
      else plan([[fwd, 2], [0, 1], [back, 2], [0, 1], [fwd, 2], [fwd | LP, 2], [0, 2]]);
      return 0;
    }
    if (d.ph !== PH.FIGHT || d.frz > 0) return mem.hold && mem.holdT > 0 ? mem.hold : 0;
    const blockP = [0.22, 0.38, 0.52, 0.66, 0.8][sk], aaP = [0.12, 0.28, 0.45, 0.6, 0.78][sk], think = [28, 22, 17, 13, 9][sk];
    // reacting: an attack coming, someone jumping in, a hubcap flying at us
    const omv = MV[o.act];
    if (o.act !== mem.oAct) {
      mem.oAct = o.act;
      if (omv && omv.dmg && dist < (omv.reach || 90) + 70 && !f.air && rnd() < blockP) { mem.hold = omv.h === 'low' ? back | D : back; mem.holdT = 22; }
    }
    if (o.air && !mem.aa && o.vy < 120 && dist < 150 && Math.sign(o.x - f.x) === f.face && !f.air) {
      mem.aa = 1;
      if (rnd() < aaP) { mem.holdT = 0; if (dist < 120 && rnd() < 0.6) plan(DPm(HP)); else plan([[D, 4], [D | HP, 2], [D, 6]]); return mem.seq.shift(); }
    }
    if (!o.air) mem.aa = 0;
    if (o.pOn && !mem.dodge && Math.sign(f.x - o.px) === Math.sign(o.pvx) && Math.abs(f.x - o.px) < 230) {
      mem.dodge = 1;
      const r = rnd();
      if (r < 0.3 && dist > 200) plan([[K.UP | fwd, 5], [0, 14], [HK, 2], [0, 20]]);
      else if (r < 0.65) { mem.hold = back; mem.holdT = 40; }
      else if (!f.pOn) plan(QCF(rnd() < 0.5 ? LP : HP));
      if (mem.seq) return mem.seq.shift();
    }
    if (!o.pOn) mem.dodge = 0;
    // just landed a light hit: keep it going into a special (the better bots do)
    if (f.conn && !mem.confirmed && (f.act === A.CLK || f.act === A.LP || f.act === A.CLP || f.act === A.LK) && rnd() < 0.25 + sk * 0.15) {
      mem.confirmed = 1;
      const r = rnd();
      plan(r < 0.4 ? QCF(LP) : r < 0.75 ? DPm(LP) : QCB(LK));
      return mem.seq.shift();
    }
    if (!f.conn) mem.confirmed = 0;
    if (f.act === A.GETUP && dist < 110 && rnd() < 0.01 + sk * 0.012) { plan(DPm(HP)); return 0; }
    if (mem.holdT > 0) { mem.holdT--; return mem.hold; }
    if (mem.wait-- > 0) return 0;
    mem.wait = think + ((rnd() * think) | 0);
    if (!isNeutral(f) || f.air) return 0;
    const r = rnd();
    if (dist > 230) {
      if (r < 0.32 && !f.pOn) plan(QCF(rnd() < 0.5 ? LP : HP));
      else if (r < 0.55) { mem.hold = fwd; mem.holdT = 18 + ((rnd() * 18) | 0); }
      else if (r < 0.68) plan([[fwd, 2], [0, 2], [fwd, 2], [0, 12]]);
      else if (r < 0.82) plan([[K.UP | fwd, 5], [0, 15], [rnd() < 0.5 ? HK : HP, 2], [0, 20]]);
      return mem.seq ? mem.seq.shift() : mem.holdT > 0 ? mem.hold : 0;
    }
    if (dist > 118) {
      if (r < 0.28) { mem.hold = fwd; mem.holdT = 10 + ((rnd() * 14) | 0); }
      else if (r < 0.42) plan([[K.UP | fwd, 5], [0, 13], [rnd() < 0.5 ? HK : LK, 2], [0, 20]]);
      else if (r < 0.55 && !f.pOn) plan(QCF(LP));
      else if (r < 0.65) plan([[0, 1], [HK, 2], [0, 6]]);
      else if (r < 0.75) plan([[fwd, 2], [0, 2], [fwd, 2], [0, 6]]);
      else if (r < 0.85) { mem.hold = back; mem.holdT = 12; }
      else { mem.hold = fwd; mem.holdT = 12; }
      return mem.seq ? mem.seq.shift() : mem.holdT > 0 ? mem.hold : 0;
    }
    if (r < 0.2) plan([[D, 2], [D | LK, 2], [D, 6], [D | LK, 2], [D, 3], ...QCF(LP)]);
    else if (r < 0.34) plan([[LP, 2], [0, 6], [LP, 2], [0, 4], [HP, 2], [0, 3], ...QCB(HK)]);
    else if (r < 0.46 && dist < 76) plan([[fwd, 2], [fwd | HP, 2], [0, 4]]);
    else if (r < 0.56) plan([[HP, 2], [0, 4], ...DPm(HP)]);
    else if (r < 0.66) plan([[D, 2], [D | HK, 2], [D, 8]]);
    else if (r < 0.76) plan([[0, 1], [LK, 2], [0, 4], ...QCB(LK)]);
    else if (r < 0.86) { mem.hold = rnd() < 0.5 ? back : back | D; mem.holdT = 24; }
    else if (r < 0.93) plan([[back, 2], [0, 2], [back, 2], [0, 10]]);
    else { mem.hold = back; mem.holdT = 10; }
    return mem.seq ? mem.seq.shift() : mem.holdT > 0 ? mem.hold : 0;
  };

  // ---------------------------------------------------------------- full state, for client-side prediction
  // Everything F.step needs, as a flat list of integers (every number in thousandths; direction times relative to
  // the current frame). A fighter's own page loads the latest state from the game, replays the keys it pressed
  // since, and keeps stepping locally, so its own moves react instantly (rollback-style). F.load(F.save(d)) steps
  // on exactly like d.
  const r3 = (v) => Math.round(v * 1000);
  F.save = function (d) {
    const out = DK.map((k) => r3(d[k]));
    for (const f of d.f) {
      for (const k of FK) out.push(r3(f[k]));
      out.push(f.dirs.length);
      for (const [dr, t] of f.dirs) out.push(dr, t - d.af);
    }
    return out;
  };
  F.load = function (v, o = 0) {
    let i = o;
    const d = { f: [] };
    for (const k of DK) d[k] = v[i++] / 1000;
    for (let n = 0; n < 2; n++) {
      const f = { dirs: [] };
      for (const k of FK) f[k] = v[i++] / 1000;
      const nd = v[i++];
      for (let j = 0; j < nd; j++) { f.dirs.push([v[i], v[i + 1] + d.af]); i += 2; }
      d.f.push(f);
    }
    d.wins = [d.w0, d.w1]; d.lh = [d.lh0, d.lh1, d.lh2, d.lh3];
    d.len = i - o;
    return d;
  };
  return F;
});
