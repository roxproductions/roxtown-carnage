// RoxTown Carnage — the car fist fight.
// When two players keep stealing the same car from each other, they settle it with their fists:
// best of three rounds in a side-on arena, Mortal Kombat style, with combos, special moves and finishing moves.
// This is the pure simulation (no I/O). game.js runs it authoritatively; clients only draw what they receive.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shared.js'));
  else factory(root.S);
})(typeof self !== 'undefined' ? self : this, function (S) {
  const K = S.K;
  const F = (S.Fight = {});
  const AW = (F.AW = 640); // arena width in fight units; fighters stand about 150 units tall
  F.ROUND_T = 45; // seconds per round
  F.WINS = 2; // round wins needed
  F.DUEL_AT = 3; // the third steal of the same car between the same two players starts a fight
  const PH = (F.PH = { INTRO: 0, FIGHT: 1, KO: 2, FINISH: 3, FATAL: 4, OVER: 5 });
  const A = (F.A = {
    IDLE: 0, WALK: 1, CROUCH: 2, BLOCK: 3, CBLOCK: 4, JUMP: 5,
    JAB: 6, KICK: 7, UPPER: 8, SWEEP: 9, JKICK: 10, HUBCAP: 11, KNEE: 12, HEEL: 13,
    HURT: 14, FALL: 15, DOWN: 16, GETUP: 17, DIZZY: 18, WIN: 19, KO: 20, FIN: 21,
  });
  // s: startup, a: active, r: recovery (seconds). h: high (whiffs over crouchers) / mid / low (only a crouching block stops it)
  const MV = (F.MV = {
    [A.JAB]: { s: 0.07, a: 0.07, r: 0.13, dmg: 5, reach: 64, h: 'high', kb: 110, stun: 0.36 },
    [A.KICK]: { s: 0.13, a: 0.08, r: 0.22, dmg: 8, reach: 86, h: 'mid', kb: 190, stun: 0.36 },
    [A.UPPER]: { s: 0.12, a: 0.08, r: 0.42, dmg: 13, reach: 62, h: 'mid', kb: 200, down: 1, lift: 600, tall: 1 },
    [A.SWEEP]: { s: 0.12, a: 0.1, r: 0.34, dmg: 8, reach: 92, h: 'low', kb: 70, down: 1, lift: 200 },
    [A.JKICK]: { s: 0.06, a: 0.6, r: 0, dmg: 9, reach: 74, h: 'high', kb: 180, stun: 0.42, air: 1 },
    [A.HUBCAP]: { s: 0.24, a: 0.02, r: 0.36, name: 'HUBCAP TOSS' },
    [A.KNEE]: { s: 0.08, a: 0.26, r: 0.3, dmg: 12, reach: 52, h: 'mid', kb: 320, down: 1, lift: 320, dash: 560, name: 'FLYING KNEE' },
    [A.HEEL]: { s: 0.16, a: 0.12, r: 0.38, dmg: 13, reach: 96, h: 'high', kb: 360, down: 1, lift: 260, name: 'SPIN HEEL' },
  });
  F.DMG = 1.35; // overall damage scale: a round lasts about half a minute
  F.HUBCAP = { dmg: 10, speed: 430, kb: 220, stun: 0.45 };
  F.COMBOS = ['', 'STREET COMBO', 'CARJACKER COMBO', 'ROAD RAGE'];
  F.FATALS = ['', 'CAR CRUSH', 'SKY HIGH', 'FIRE STARTER'];
  F.FATAL_T = 3.4;
  const NAMED = [
    // [moves in order, name index, bonus damage]
    [[A.JAB, A.JAB, A.KICK], 1, 5],
    [[A.JAB, A.KICK, A.UPPER], 2, 7],
    [[A.KICK, A.KICK, A.HEEL], 3, 8],
  ];

  function fighter(x, face) {
    return {
      x, y: 0, vx: 0, vy: 0, kbx: 0, face, hp: 100, act: A.IDLE, at: 0, air: false, jk: false,
      pk: 0, hist: [], buf: null, held: { F: 0, B: 0, D: 0, U: 0 }, hitDone: false, stun: 0, bs: 0,
      combo: 0, cn: 0, chain: [], lastHitT: -9, proj: null, taken: 0, thrown: false,
    };
  }
  F.create = function (id) {
    const d = { id, ph: PH.INTRO, t: 0, clock: 0, round: 1, wins: [0, 0], rt: F.ROUND_T, f: null, win: -1, rw: -1, fk: 0, flaw: 0, res: 0, hs: 0, lh: [0, 0, 0], done: false };
    resetRound(d);
    return d;
  };
  function resetRound(d) {
    d.f = [fighter(AW / 2 - 130, 1), fighter(AW / 2 + 130, -1)];
    d.rt = F.ROUND_T; d.ph = PH.INTRO; d.t = 0; d.rw = -1; d.flaw = 0;
  }

  const neutral = (f) => f.act <= A.JUMP && f.act !== A.JUMP;
  const invuln = (f) => f.act === A.DOWN || f.act === A.GETUP || f.act === A.KO || (f.act === A.FALL && !(f.air && f.at < 0.45));
  function threat(d, i) {
    const o = d.f[1 - i], f = d.f[i];
    if (o.proj && Math.sign(f.x - o.proj.x) === Math.sign(o.proj.vx) && Math.abs(f.x - o.proj.x) < 260) return true;
    const mv = MV[o.act];
    return !!(mv && Math.abs(o.x - f.x) < 190 && o.at < mv.s + mv.a);
  }

  // ---------------------------------------------------------------- input
  function control(d, i, k, live) {
    const f = d.f[i];
    const prev = f.pk; f.pk = k;
    if (!live) { f.held = { F: 0, B: 0, D: 0, U: 0 }; f.buf = null; return; }
    const fwdK = f.face > 0 ? K.RIGHT : K.LEFT, backK = f.face > 0 ? K.LEFT : K.RIGHT;
    const press = (b) => k & b && !(prev & b);
    const T = d.clock;
    if (press(fwdK)) f.hist.push(['F', T]);
    if (press(backK)) f.hist.push(['B', T]);
    if (press(K.DOWN)) f.hist.push(['D', T]);
    if (press(K.UP)) f.hist.push(['U', T]);
    while (f.hist.length > 8) f.hist.shift();
    f.held = { F: k & fwdK ? 1 : 0, B: k & backK ? 1 : 0, D: k & K.DOWN ? 1 : 0, U: k & K.UP ? 1 : 0 };
    const btn = press(K.FIRE) ? 'P' : press(K.HAND) ? 'K' : null;
    if (btn) f.buf = { b: btn, t: T, m: f.hist.filter((h) => T - h[1] < 0.7).map((h) => h[0]).join('') };
    if (f.buf && T - f.buf.t > 0.18) f.buf = null;
  }
  function begin(f, act) {
    f.act = act; f.at = 0; f.hitDone = false; f.thrown = false;
    if (!f.air) f.vx = 0;
  }
  function tryAttack(d, i) {
    const f = d.f[i], o = d.f[1 - i], b = f.buf;
    if (!b) return;
    const m = b.m, dist = Math.abs(o.x - f.x);
    if (d.ph === PH.FINISH && i === d.win) {
      let fk = 0;
      if (b.b === 'K' && m.endsWith('BB')) fk = 1;
      else if (b.b === 'P' && m.endsWith('DU') && dist < 140) fk = 2;
      else if (b.b === 'P' && m.endsWith('FBF') && dist < 280) fk = 3;
      if (fk) { f.buf = null; d.fk = fk; d.ph = PH.FATAL; d.t = 0; f.act = A.FIN; f.at = 0; f.vx = 0; f.kbx = 0; return; }
    }
    if (f.air) {
      if (f.jk || f.act !== A.JUMP) return;
      f.jk = true; f.buf = null; f.act = A.JKICK; f.at = 0; f.hitDone = false;
      return;
    }
    if (!neutral(f)) return; // stays buffered for a moment, so moves chain into combos
    let act;
    if (b.b === 'P' && m.endsWith('BF') && !f.proj) act = A.HUBCAP;
    else if (b.b === 'K' && m.endsWith('FF')) act = A.KNEE;
    else if (b.b === 'K' && m.endsWith('DB')) act = A.HEEL;
    else if (f.held.D) act = b.b === 'P' ? A.UPPER : A.SWEEP;
    else act = b.b === 'P' ? A.JAB : A.KICK;
    f.buf = null;
    begin(f, act);
  }

  // ---------------------------------------------------------------- hits
  function hit(d, i, mv, act, isProj) {
    const f = d.f[i], o = d.f[1 - i];
    const dir = isProj ? Math.sign(f.proj.vx) : f.face;
    const canBlock = !o.air && (neutral(o) || o.bs > 0) && o.act !== A.DIZZY;
    const blocking = canBlock && o.held.B && (o.held.D || mv.h !== 'low');
    d.hs++;
    if (blocking) {
      const chip = mv.dmg * 0.15;
      o.hp = Math.max(1, o.hp - chip); o.taken += chip;
      o.act = o.held.D ? A.CBLOCK : A.BLOCK; o.bs = 0.18; o.at = 0; o.vx = 0; o.kbx = dir * mv.kb * 0.6;
      f.combo = 0; f.chain = [];
      d.lh = [2 - i, Math.round(chip), 1, act];
      return;
    }
    const chain = (o.act === A.HURT || (o.act === A.FALL && o.air) || o.act === A.DIZZY) && d.clock - f.lastHitT < 1.3;
    f.combo = chain ? f.combo + 1 : 1;
    f.chain = chain ? f.chain.concat(act).slice(-4) : [act];
    f.lastHitT = d.clock; f.cn = 0;
    let dmg = mv.dmg * F.DMG + Math.max(0, f.combo - 2) * 1.5, named = false;
    for (const [seq, n, bonus] of NAMED) {
      if (f.chain.length >= seq.length && seq.every((a, j) => f.chain[f.chain.length - seq.length + j] === a)) { f.cn = n; dmg += bonus; named = true; }
    }
    o.hp = Math.max(0, o.hp - dmg); o.taken += dmg;
    d.lh = [2 - i, Math.round(dmg), 0, act];
    o.vx = 0;
    if (o.act === A.DIZZY) {
      // the beaten fighter goes down: no fatality this time
      o.act = A.FALL; o.at = 0; o.air = true; o.vy = 380; o.kbx = dir * 260;
      d.res = 1; d.ph = PH.OVER; d.t = 0;
      return;
    }
    if (mv.down || named || o.hp <= 0 || o.air) {
      o.act = A.FALL; o.at = 0; o.air = true; o.vy = Math.max(mv.lift || 0, o.hp <= 0 ? 420 : 300); o.kbx = dir * Math.max(mv.kb, 220);
    } else {
      o.act = A.HURT; o.at = 0; o.stun = mv.stun || 0.4; o.kbx = dir * mv.kb;
    }
    if (o.hp <= 0) ko(d, i);
  }
  function ko(d, wi) {
    const w = d.f[wi], l = d.f[1 - wi];
    d.wins[wi]++; d.rw = wi; d.flaw = w.taken < 0.5 ? 1 : 0;
    w.proj = null; l.proj = null;
    if (d.wins[wi] >= F.WINS) {
      // final knockout: the loser staggers back up, dazed, and the winner gets the chance to finish it
      d.win = wi; d.ph = PH.FINISH; d.t = 0;
      l.act = A.DIZZY; l.at = 0; l.air = false; l.y = 0; l.vy = 0; l.hp = 0;
    } else { d.ph = PH.KO; d.t = 0; }
  }
  function checkHit(d, i) {
    const f = d.f[i], o = d.f[1 - i], mv = MV[f.act];
    if (!mv || !mv.dmg || f.hitDone) return;
    if (f.at < mv.s || f.at > mv.s + mv.a) return;
    if (invuln(o)) return;
    const dx = (o.x - f.x) * f.face;
    if (dx < -10 || dx > mv.reach + 24) return;
    const dy = o.y - f.y;
    if (dy > (mv.tall ? 150 : mv.air ? 110 : 70) || dy < -95) return;
    if (mv.h === 'high' && !o.air && (o.act === A.CROUCH || o.act === A.CBLOCK)) return; // goes over a crouching head
    f.hitDone = true;
    hit(d, i, mv, f.act, false);
  }

  // ---------------------------------------------------------------- per-fighter update
  function update(d, i, dt, live) {
    const f = d.f[i], o = d.f[1 - i];
    f.at += dt;
    if (f.bs > 0) f.bs -= dt;
    if (live) tryAttack(d, i);
    const mv = MV[f.act];
    // movement from held directions
    if (!f.air && (neutral(f) && f.bs <= 0)) {
      f.face = o.x >= f.x ? 1 : -1;
      if (live && f.held.U && d.ph === PH.FIGHT) {
        f.act = A.JUMP; f.at = 0; f.air = true; f.jk = false; f.vy = 560;
        f.vx = f.held.F ? 200 * f.face : f.held.B ? -180 * f.face : 0;
      } else if (live && f.held.D) { f.act = f.held.B ? A.CBLOCK : A.CROUCH; f.vx = 0; }
      else if (live && f.held.F) { f.act = A.WALK; f.vx = 150 * f.face; }
      else if (live && f.held.B) { const blk = threat(d, i); f.act = blk ? A.BLOCK : A.WALK; f.vx = blk ? 0 : -120 * f.face; }
      else { f.act = A.IDLE; f.vx = 0; }
    }
    // timed actions
    if (mv) {
      if (f.act === A.KNEE) f.vx = f.at > mv.s && f.at < mv.s + mv.a ? mv.dash * f.face : 0;
      if (f.act === A.HUBCAP && !f.thrown && f.at >= mv.s) {
        f.thrown = true;
        f.proj = { x: f.x + f.face * 40, y: 104, vx: F.HUBCAP.speed * f.face, t: 0 };
      }
      if (f.act === A.JKICK) { if (!f.air) { f.act = A.IDLE; f.at = 0; } }
      else if (f.at >= mv.s + mv.a + mv.r) { f.act = f.air ? A.JUMP : A.IDLE; f.at = 0; f.vx = f.air ? f.vx : 0; }
      checkHit(d, i);
    } else if (f.act === A.HURT && f.at >= f.stun) { f.act = A.IDLE; f.at = 0; }
    else if (f.act === A.DOWN && f.at >= 0.7) {
      if (f.hp > 0) { f.act = A.GETUP; f.at = 0; } else { f.act = A.KO; f.at = 0; }
    } else if (f.act === A.GETUP && f.at >= 0.35) { f.act = A.IDLE; f.at = 0; }
    else if ((f.act === A.BLOCK || f.act === A.CBLOCK) && f.bs <= 0 && !live) { f.act = A.IDLE; }
    // physics
    if (f.air) {
      f.vy -= 1500 * dt; f.y += f.vy * dt;
      if (f.y <= 0) {
        f.y = 0; f.vy = 0; f.air = false;
        if (f.act === A.FALL) { f.act = A.DOWN; f.at = 0; }
        else if (f.act === A.JUMP || f.act === A.JKICK) { f.act = A.IDLE; f.at = 0; f.vx = 0; }
      }
    }
    if (f.act === A.FIN || f.act === A.DIZZY || f.act === A.KO || f.act === A.DOWN) f.vx = 0;
    f.x += (f.vx + f.kbx) * dt;
    f.kbx *= Math.exp(-(f.air ? 2 : 9) * dt);
    if (f.x < 30) { f.x = 30; f.kbx = 0; }
    if (f.x > AW - 30) { f.x = AW - 30; f.kbx = 0; }
    // hubcap in flight
    if (f.proj) {
      const p = f.proj;
      p.t += dt; p.x += p.vx * dt;
      if (p.x < -40 || p.x > AW + 40) f.proj = null;
      else if (!invuln(o) && Math.abs(o.x - p.x) < 26 && o.y < 130) {
        const croucher = !o.air && (o.act === A.CROUCH || o.act === A.CBLOCK);
        if (!croucher) { hit(d, i, { dmg: F.HUBCAP.dmg, kb: F.HUBCAP.kb, stun: F.HUBCAP.stun, h: 'high' }, A.HUBCAP, true); f.proj = null; }
      }
    }
  }
  function separate(d) {
    const [a, b] = d.f;
    if (Math.abs(a.y - b.y) > 60) return;
    if (a.act === A.KO || b.act === A.KO || a.act === A.DOWN || b.act === A.DOWN) return;
    const dx = b.x - a.x, min = 46;
    if (Math.abs(dx) < min) {
      const push = (min - Math.abs(dx)) / 2, s = dx >= 0 ? 1 : -1;
      a.x -= push * s; b.x += push * s;
      for (const f of d.f) f.x = Math.max(30, Math.min(AW - 30, f.x));
    }
  }

  // ---------------------------------------------------------------- the fight's state machine
  // keys: [fighter 0 keys, fighter 1 keys] (the usual K bitmask: arrows, FIRE = punch, HAND = kick)
  // every float rounded to a thousandth after each step, so a state sent over the network (F.save) is exact and
  // a fighter's page that replays the same keys gets bit-for-bit the same fight as the game
  const q = (v) => Math.round(v * 1000) / 1000;
  function quant(d) {
    d.t = q(d.t); d.clock = q(d.clock); d.rt = q(d.rt);
    for (const f of d.f) {
      f.x = q(f.x); f.y = q(f.y); f.vx = q(f.vx); f.vy = q(f.vy); f.kbx = q(f.kbx); f.hp = q(f.hp); f.at = q(f.at);
      f.stun = q(f.stun); f.bs = q(f.bs); f.lastHitT = q(f.lastHitT); f.taken = q(f.taken);
      if (f.proj) { f.proj.x = q(f.proj.x); f.proj.vx = q(f.proj.vx); f.proj.t = q(f.proj.t); }
      if (f.buf) f.buf.t = q(f.buf.t);
      for (const h of f.hist) h[1] = q(h[1]);
      while (f.hist.length && d.clock - f.hist[0][1] >= 0.75) f.hist.shift(); // older presses never matter
    }
  }
  F.step = function (d, keys, dt) {
    if (d.done) return;
    stepInner(d, keys, dt);
    quant(d);
  };
  function stepInner(d, keys, dt) {
    d.t += dt; d.clock += dt;
    const live0 = d.ph === PH.FIGHT || (d.ph === PH.FINISH && d.win === 0);
    const live1 = d.ph === PH.FIGHT || (d.ph === PH.FINISH && d.win === 1);
    control(d, 0, keys[0] | 0, live0);
    control(d, 1, keys[1] | 0, live1);
    if (d.ph !== PH.FATAL) {
      update(d, 0, dt, live0);
      update(d, 1, dt, live1);
      separate(d);
    }
    switch (d.ph) {
      case PH.INTRO:
        if (d.t >= 2.1) { d.ph = PH.FIGHT; d.t = 0; }
        break;
      case PH.FIGHT:
        d.rt -= dt;
        if (d.rt <= 0) {
          d.rt = 0;
          const [a, b] = d.f;
          if (Math.abs(a.hp - b.hp) < 0.5) { d.rw = -1; d.ph = PH.KO; d.t = 0; } // a draw: the round is replayed
          else {
            const wi = a.hp > b.hp ? 0 : 1, l = d.f[1 - wi];
            l.hp = 0; l.act = A.FALL; l.at = 0; l.air = true; l.vy = 300;
            ko(d, wi);
          }
        }
        break;
      case PH.KO: {
        const w = d.rw >= 0 ? d.f[d.rw] : null;
        if (w && d.t > 1.2 && neutral(w) && !w.air) { w.act = A.WIN; w.at = 0; }
        if (d.t >= 3.4) {
          d.round++;
          if (d.round > 7) { d.win = d.wins[0] >= d.wins[1] ? 0 : 1; d.res = 1; d.ph = PH.OVER; d.t = 0; break; }
          resetRound(d);
        }
        break;
      }
      case PH.FINISH:
        if (d.t >= 7) {
          const l = d.f[1 - d.win];
          l.act = A.FALL; l.at = 0; l.air = true; l.vy = 200;
          d.res = 1; d.ph = PH.OVER; d.t = 0;
        }
        break;
      case PH.FATAL:
        if (d.t >= F.FATAL_T) { d.res = 2; d.ph = PH.OVER; d.t = 0; d.f[d.win].act = A.WIN; d.f[d.win].at = 0; }
        break;
      case PH.OVER: {
        const w = d.f[d.win];
        if (d.t > 0.8 && w.act !== A.WIN && neutral(w)) { w.act = A.WIN; w.at = 0; }
        if (d.t >= 2.8) d.done = true;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- bot fighter
  // Returns the key bitmask a bot presses this tick. mem is the bot's own scratch object.
  F.bot = function (d, i, mem, rnd) {
    const f = d.f[i], o = d.f[1 - i];
    const fwd = f.face > 0 ? K.RIGHT : K.LEFT, back = f.face > 0 ? K.LEFT : K.RIGHT;
    const script = (steps) => { mem.seq = []; for (const s of steps) { for (let n = 0; n < 3; n++) mem.seq.push(s); mem.seq.push(0, 0); } };
    if (d.ph !== mem.ph) { mem.ph = d.ph; mem.seq = null; mem.wait = 0.6 + rnd() * 0.9; mem.hold = 0; mem.holdT = 0; }
    if (mem.seq && mem.seq.length) return mem.seq.shift();
    const dist = Math.abs(o.x - f.x);
    if (d.ph === PH.FINISH) {
      if (i !== d.win) return 0;
      mem.wait -= 1 / 60;
      if (mem.wait > 0) return 0;
      if (!mem.pick) mem.pick = 1 + Math.floor(rnd() * 3);
      if (mem.pick === 2 && dist > 110) return fwd;
      if (mem.pick === 3 && dist > 240) return fwd;
      if (mem.pick === 1) script([back, back, K.HAND]);
      else if (mem.pick === 2) script([K.DOWN, K.UP, K.FIRE]);
      else script([fwd, back, fwd, K.FIRE]);
      return 0;
    }
    if (d.ph !== PH.FIGHT) return 0;
    // react to an attack starting: block about half the time (they're no pros)
    const mv = MV[o.act];
    if (o.act !== mem.oAct) {
      mem.oAct = o.act;
      if (mv && dist < 170 && rnd() < 0.4) { mem.hold = o.act === A.SWEEP ? back | K.DOWN : back; mem.holdT = 0.45; }
    }
    if (o.proj && Math.abs(o.proj.x - f.x) < 200 && !mem.dodged) { mem.dodged = true; const r = rnd(); if (r < 0.35) { mem.hold = K.DOWN; mem.holdT = 0.5; } else if (r < 0.6) { mem.hold = back; mem.holdT = 0.5; } }
    if (!o.proj) mem.dodged = false;
    if (mem.holdT > 0) { mem.holdT -= 1 / 60; return mem.hold; }
    mem.wait -= 1 / 60;
    if (mem.wait > 0) return 0;
    mem.wait = 0.2 + rnd() * 0.35;
    const r = rnd();
    if (dist > 170) {
      if (r < 0.22 && !f.proj) { script([back, fwd | K.FIRE]); return 0; }
      if (r < 0.3) { script([K.UP | fwd]); mem.seq.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, K.HAND, K.HAND); return 0; }
      mem.hold = fwd; mem.holdT = 0.3 + rnd() * 0.3; return fwd;
    }
    if (dist > 100) {
      if (r < 0.25) { script([fwd, fwd, K.HAND]); return 0; }
      if (r < 0.4) { script([K.DOWN, back, K.HAND]); return 0; }
      mem.hold = fwd; mem.holdT = 0.2; return fwd;
    }
    if (r < 0.3) { mem.seq = [K.FIRE, K.FIRE, ...Array(10).fill(0), K.FIRE, K.FIRE, ...Array(10).fill(0), K.HAND, K.HAND]; return 0; }
    if (r < 0.45) { mem.seq = [K.HAND, K.HAND]; return 0; }
    if (r < 0.57) { mem.seq = Array(6).fill(K.DOWN).concat([K.DOWN | K.HAND, K.DOWN | K.HAND], Array(10).fill(K.DOWN)); return 0; }
    if (r < 0.7) { mem.seq = Array(6).fill(K.DOWN).concat([K.DOWN | K.FIRE, K.DOWN | K.FIRE], Array(10).fill(K.DOWN)); return 0; }
    if (r < 0.78) { script([K.FIRE]); mem.seq.push(...Array(8).fill(0), K.FIRE, K.FIRE, ...Array(10).fill(0), K.DOWN, K.DOWN, K.DOWN | K.FIRE, K.DOWN | K.FIRE); return 0; }
    mem.hold = back; mem.holdT = 0.25; return back;
  };

  // ---------------------------------------------------------------- network form
  // A flat list of integers, decoded with F.unpack on the client.
  const FPACK = 10;
  F.pack = function (d) {
    const out = [d.ph, d.round, d.wins[0], d.wins[1], Math.round(d.t * 20), Math.ceil(d.rt), d.win + 1, d.rw + 1, d.fk, d.flaw, d.res, d.hs % 4096, d.lh[0], d.lh[1], d.lh[2], d.lh[3]];
    for (const f of d.f) out.push(Math.round(f.x), Math.round(f.y), Math.ceil(f.hp), f.act, Math.min(4095, Math.round(f.at * 100)), f.face > 0 ? 1 : 0, f.combo, f.cn, f.proj ? Math.round(f.proj.x) : -999, f.proj ? (f.proj.vx > 0 ? 1 : 0) : 0);
    return out;
  };
  F.PACKLEN = 16 + FPACK * 2;
  F.unpack = function (v, o = 0) {
    const d = { ph: v[o], round: v[o + 1], wins: [v[o + 2], v[o + 3]], t: v[o + 4] / 20, rt: v[o + 5], win: v[o + 6] - 1, rw: v[o + 7] - 1, fk: v[o + 8], flaw: v[o + 9], res: v[o + 10], hs: v[o + 11], lh: [v[o + 12] - 1, v[o + 13], v[o + 14], v[o + 15]], f: [] };
    for (let i = 0; i < 2; i++) {
      const b = o + 16 + i * FPACK;
      d.f.push({ x: v[b], y: v[b + 1], hp: v[b + 2], act: v[b + 3], at: v[b + 4] / 100, face: v[b + 5] ? 1 : -1, combo: v[b + 6], cn: v[b + 7], px: v[b + 8], pvx: v[b + 9] ? 1 : -1 });
    }
    return d;
  };
  // ---------------------------------------------------------------- full state, for client-side prediction
  // Everything F.step needs, as a flat list of integers (times and positions in thousandths). A fighter's own page
  // loads the latest state from the game, replays the keys it pressed since, and keeps stepping locally, so
  // its own moves react instantly (rollback-style). F.load(F.save(d)) steps on exactly like d.
  const TOKS = ' FBDU', BTNS = ' PK';
  const encM = (m) => { let n = 0; for (let i = m.length - 1; i >= 0; i--) n = n * 5 + TOKS.indexOf(m[i]); return n; };
  const decM = (n) => { let m = ''; while (n > 0) { m += TOKS[n % 5]; n = Math.floor(n / 5); } return m; };
  F.save = function (d) {
    const r = (v) => Math.round(v * 1000), m = r; // positions and times in thousandths
    const out = [d.ph, m(d.t), m(d.clock), d.round, d.wins[0], d.wins[1], m(d.rt), d.win, d.rw, d.fk, d.flaw, d.res, d.hs, d.lh[0], d.lh[1], d.lh[2], d.lh[3], d.done ? 1 : 0];
    for (const f of d.f) {
      const hist = f.hist, p = f.proj;
      out.push(r(f.x), r(f.y), r(f.vx), r(f.vy), r(f.kbx), f.face, r(f.hp), f.act, m(f.at), f.air ? 1 : 0, f.jk ? 1 : 0, f.pk, f.hitDone ? 1 : 0,
        m(f.stun), m(f.bs), f.combo, f.cn, m(f.lastHitT), r(f.taken), f.thrown ? 1 : 0,
        f.held.F | (f.held.B << 1) | (f.held.D << 2) | (f.held.U << 3),
        p ? 1 : 0, p ? r(p.x) : 0, p ? r(p.vx) : 0, p ? m(p.t) : 0,
        f.buf ? BTNS.indexOf(f.buf.b) : 0, f.buf ? m(f.buf.t) : 0, f.buf ? encM(f.buf.m) : 0,
        f.chain.length, ...f.chain, hist.length);
      for (const h of hist) out.push(TOKS.indexOf(h[0]), m(h[1]));
    }
    return out;
  };
  F.load = function (v, o = 0) {
    let i = o;
    const n = () => v[i++], t = () => v[i++] / 1000, ms = t;
    const d = { ph: n(), t: ms(), clock: ms(), round: n(), wins: [n(), n()], rt: ms(), win: n(), rw: n(), fk: n(), flaw: n(), res: n(), hs: n(), lh: [n(), n(), n(), n()], done: !!n(), f: [] };
    for (let k = 0; k < 2; k++) {
      const f = { x: t(), y: t(), vx: t(), vy: t(), kbx: t(), face: n(), hp: t(), act: n(), at: ms(), air: !!n(), jk: !!n(), pk: n(), hitDone: !!n(),
        stun: ms(), bs: ms(), combo: n(), cn: n(), lastHitT: ms(), taken: t(), thrown: !!n() };
      const h = n(); f.held = { F: h & 1, B: (h >> 1) & 1, D: (h >> 2) & 1, U: (h >> 3) & 1 };
      const hasP = n(), px = t(), pvx = t(), pt = ms();
      f.proj = hasP ? { x: px, y: 104, vx: pvx, t: pt } : null;
      const bb = n(), bt = ms(), bm = n();
      f.buf = bb ? { b: BTNS[bb], t: bt, m: decM(bm) } : null;
      const cl = n(); f.chain = []; for (let j = 0; j < cl; j++) f.chain.push(n());
      const hl = n(); f.hist = []; for (let j = 0; j < hl; j++) { const tk = TOKS[n()]; f.hist.push([tk, ms()]); }
      d.f.push(f);
    }
    d.len = i - o;
    return d;
  };
  return F;
});
