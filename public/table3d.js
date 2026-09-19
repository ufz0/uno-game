import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/* ---------- shared constants ---------- */

const TABLE = { y: 0.77, size: 1.3 };
const CARD = { w: 0.078, h: 0.11, t: 0.003 };
// physics box is a bit thicker than the visual card so a fast toss
// cannot tunnel through the table top in one step
const PHYS_T = 0.009;
const FAN = { step: 0.046, tilt: 0.14, lift: 0.012 };
const DECK_POS = new CANNON.Vec3(-0.3, TABLE.y, -0.22);
const DISCARD_POS = new CANNON.Vec3(0.3, TABLE.y, -0.22);
// seat 0 = you (south), 1 = north, 2 = east, 3 = west
const SEAT_UNITS = [
  { x: 0, z: 1 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: -1, z: 0 },
];
const SEAT_R = 1.05;
const HAND_R = 0.42;
const HAND_ANCHOR_Y = TABLE.y + 0.0255;
const SKIN_TONES = ['#e9b48f', '#c98a63', '#8d5a3b', '#f1c9a6'];

const COLOR_HEX = { red: '#e5311b', yellow: '#f2a900', green: '#009a4d', blue: '#0669b0' };
const OPP_FILL = { 1: [1], 2: [2, 3], 3: [1, 2, 3] };

export function seatFor(index, yourIndex, players) {
  if (index === yourIndex) return 0;
  const others = players.filter((p) => p.index !== yourIndex).sort((a, b) => a.index - b.index);
  const fill = OPP_FILL[others.length] || [1];
  return fill[others.findIndex((p) => p.index === index)] ?? 1;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------- CardSim: pure physics, no DOM/WebGL ---------- */

export class CardSim {
  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.world.allowSleep = true;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 12;
    this.world.solver.tolerance = 0.05;

    this.cardMat = new CANNON.Material('card');
    this.tableMat = new CANNON.Material('table');
    this.floorMat = new CANNON.Material('floor');
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.cardMat, this.tableMat, { friction: 0.4, restitution: 0.03 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.cardMat, this.cardMat, { friction: 0.35, restitution: 0.01 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.cardMat, this.floorMat, { friction: 0.6, restitution: 0.05 }));

    const top = new CANNON.Body({
      type: CANNON.Body.STATIC,
      mass: 0,
      material: this.tableMat,
      shape: new CANNON.Box(new CANNON.Vec3(TABLE.size / 2, 0.0225, TABLE.size / 2)),
      position: new CANNON.Vec3(0, TABLE.y - 0.0225, 0),
    });
    this.world.addBody(top);
    const floor = new CANNON.Body({
      type: CANNON.Body.STATIC,
      mass: 0,
      material: this.floorMat,
      shape: new CANNON.Box(new CANNON.Vec3(6, 0.05, 6)),
      position: new CANNON.Vec3(0, -0.05, 0),
    });
    this.world.addBody(floor);

    this.cards = new Map();
    this.hands = [[], [], [], []];
    this.deckStack = [];
    this.topId = null;
    this.time = 0;
    this.myTurn = false;
    this.liftT = 0;
    this.gesture = [0, 0, 0, 0];
    this._seq = 0;
  }

  _makeCard(face, seat, { state = 'held' } = {}) {
    const id = face && face.id ? face.id : `sim${++this._seq}`;
    // Only 'flying' and 'table' cards carry a physics body. Hand,
    // deck and animating cards are pure visuals: the fanned hand is
    // a stack of overlapping boxes, so a body there would be crushed
    // by the solver the moment a neighbour is released.
    const c = {
      id,
      face: face ? { ...face } : null,
      seat,
      state,
      body: null,
      pos: new CANNON.Vec3(0, -2, 0),
      quat: new CANNON.Quaternion(),
      anim: null,
      rest: 0,
      jitter: { dx: rand(-0.004, 0.004), dz: rand(-0.004, 0.004), yaw: rand(-0.06, 0.06) },
      _hover: 0,
    };
    this.cards.set(id, c);
    return c;
  }

  _spawnBody(c) {
    const body = new CANNON.Body({
      mass: 0.02,
      material: this.cardMat,
      shape: new CANNON.Box(new CANNON.Vec3(CARD.w / 2, PHYS_T / 2, CARD.h / 2)),
      position: c.pos.clone(),
      quaternion: c.quat.clone(),
      allowSleep: true,
    });
    body.sleepSpeedLimit = 0.2;
    body.sleepTimeLimit = 0.5;
    this.world.addBody(body);
    c.body = body;
    return body;
  }

  _despawnBody(c) {
    if (c.body) {
      this.world.removeBody(c.body);
      c.body = null;
    }
  }

  reset() {
    for (const c of this.cards.values()) this._despawnBody(c);
    this.cards.clear();
    this.hands = [[], [], [], []];
    this.deckStack = [];
    this.topId = null;
    this.liftT = 0;
    this.gesture = [0, 0, 0, 0];
  }

  handCount(seat) {
    return this.hands[seat].length;
  }

  // Where card i (of n) rests in a hand: fanned around the hand's pivot.
  handSlotTransform(seat, i, n) {
    const u = SEAT_UNITS[seat];
    const lift = seat === 0 ? FAN.lift * this.liftT : 0;
    const anchor = new CANNON.Vec3(u.x * HAND_R, HAND_ANCHOR_Y + lift, u.z * HAND_R);
    const f = new CANNON.Vec3(-u.x, 0, -u.z);
    const r = new CANNON.Vec3(-f.z, 0, f.x);
    const mid = (n - 1) / 2;
    const a = (i - mid) * FAN.step;
    const rotY = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), a);
    const tiltA = FAN.tilt + (seat === 0 ? 0.05 * this.liftT : 0);
    const tilt = new CANNON.Quaternion().setFromAxisAngle(r, tiltA);
    let q;
    if (seat === 0) {
      q = tilt.mult(rotY);
    } else {
      // opponents hold their cards face down (the face stays hidden)
      const flip = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI);
      q = tilt.mult(rotY.mult(flip));
    }
    const dir = rotY.vmult(f);
    let pos = anchor.vadd(dir.scale(CARD.h * 0.5 + 0.012));
    pos = anchor.vadd(tilt.vmult(pos.vsub(anchor)));
    return { p: pos, q };
  }

  deckSlot(i, c) {
    const p = new CANNON.Vec3(DECK_POS.x + c.jitter.dx, TABLE.y + 0.0015 + i * CARD.t, DECK_POS.z + c.jitter.dz);
    const q = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), c.jitter.yaw);
    return { p, q };
  }

  triggerGesture(seat) {
    if (seat >= 0 && seat < 4) this.gesture[seat] = 1;
  }

  releaseCard(id, { reveal = null, flip = false, target = null } = {}) {
    const c = this.cards.get(id);
    if (!c || (c.state !== 'held' && c.state !== 'anim')) return false;
    if (c.seat != null) {
      const arr = this.hands[c.seat];
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
      c.seat = null;
    }
    if (reveal) c.face = { ...reveal };
    c.anim = null;
    c.state = 'flying';
    c.rest = 0;
    const b = this._spawnBody(c);
    b.sleepState = CANNON.Body.AWAKE;
    const t = target || DISCARD_POS;
    const to = new CANNON.Vec3(t.x - c.pos.x, 0, t.z - c.pos.z);
    const d = to.length() || 0.01;
    to.scale(1 / d);
    const v = clamp(2.2 * d, 1.2, 2.2);
    b.velocity.set(to.x * v, 0.55, to.z * v);
    if (flip) {
      const lx = c.quat.vmult(new CANNON.Vec3(1, 0, 0));
      b.angularVelocity.set(lx.x * 5.4 + rand(-0.8, 0.8), rand(-1.2, 1.2), lx.z * 5.4 + rand(-0.8, 0.8));
    } else {
      b.angularVelocity.set(rand(-1.6, 1.6), rand(-1.6, 1.6), rand(-1, 1));
    }
    return true;
  }

  releaseIfHeld(id) {
    const c = this.cards.get(id);
    if (!c || c.state !== 'held' || c.seat !== 0) return false;
    return this.releaseCard(id);
  }

  opponentPlays(seat, face) {
    const arr = this.hands[seat];
    if (!arr.length) {
      // self-heal: a state we missed — conjure the played card from the fan
      const c = this._makeCard(face, null, { state: 'held' });
      const slot = this.handSlotTransform(seat, 0, 1);
      c.pos.copy(slot.p);
      c.quat.copy(slot.q);
      this.releaseCard(c.id, { flip: true });
      return c.id;
    }
    const id = arr[Math.floor(arr.length / 2)];
    return this.releaseCard(id, { reveal: face, flip: true }) ? id : null;
  }

  discardBack(seat) {
    const arr = this.hands[seat];
    if (!arr.length) return null;
    return this.releaseCard(arr[arr.length - 1]);
  }

  drawInto(seat, faceData = null) {
    if (!this.deckStack.length) return null;
    const id = this.deckStack.pop();
    const c = this.cards.get(id);
    if (!c) return null;
    if (faceData) c.face = { ...faceData };
    c.seat = seat;
    this.hands[seat].push(id);
    c.state = 'anim';
    c.anim = {
      fp: c.pos.clone(),
      fq: c.quat.clone(),
      t0: this.time,
      dur: 0.55,
      arc: 0.15,
      seat,
      dest: 'hand',
    };
    return id;
  }

  recall(id, seat) {
    const c = this.cards.get(id);
    if (!c) return;
    c.seat = seat;
    if (!this.hands[seat].includes(id)) this.hands[seat].push(id);
    c.state = 'anim';
    this._despawnBody(c);
    c.anim = {
      fp: c.pos.clone(),
      fq: c.quat.clone(),
      t0: this.time,
      dur: 0.4,
      arc: 0.08,
      seat,
      dest: 'hand',
    };
  }

  setDeckCount(n) {
    while (this.deckStack.length > n) {
      const id = this.deckStack.pop();
      const c = this.cards.get(id);
      if (c) {
        this._despawnBody(c);
        this.cards.delete(id);
      }
    }
    while (this.deckStack.length < n) {
      const c = this._makeCard(null, null, { state: 'deck' });
      const s = this.deckSlot(this.deckStack.length, c);
      c.pos.copy(s.p);
      c.quat.copy(s.q);
      this.deckStack.push(c.id);
    }
  }

  // The top card may be a sim card whose own id differs from the server's
  // top id (an opponent's played card carries its old hand id and only its
  // face was replaced), so match by id or face id.
  topCard() {
    if (!this.topId) return null;
    const c = this.cards.get(this.topId);
    if (c) return c;
    for (const k of this.cards.values()) {
      if (k.face && k.face.id === this.topId) return k;
    }
    return null;
  }

  setTop(id) {
    this.topId = id;
    const c = this.topCard();
    if (c && c.state === 'table' && !c.anim) this._tidyTop(c);
  }

  reshuffle(topId) {
    this.topId = topId;
    let i = 0;
    for (const c of this.cards.values()) {
      if (c.id === topId) continue;
      if (c.state === 'table' || c.state === 'flying') {
        c.seat = null;
        c.state = 'anim';
        this._despawnBody(c);
        c.anim = {
          fp: c.pos.clone(),
          fq: c.quat.clone(),
          t0: this.time,
          dur: 0.7 + (i % 14) * 0.05,
          arc: 0.25,
          dest: 'deck',
          spin: rand(2.5, 5.5),
        };
        i++;
      }
    }
  }

  deal({ you, others, deckCount, top }) {
    this.reset();
    for (let i = 0; i < deckCount; i++) {
      const c = this._makeCard(null, null, { state: 'deck' });
      const s = this.deckSlot(this.deckStack.length, c);
      c.pos.copy(s.p);
      c.quat.copy(s.q);
      this.deckStack.push(c.id);
    }
    const t = this._makeCard(top, null, { state: 'anim' });
    t.pos.set(DISCARD_POS.x, TABLE.y + 0.28, DISCARD_POS.z);
    t.quat.copy(new CANNON.Quaternion());
    t.anim = { fp: t.pos.clone(), fq: t.quat.clone(), t0: this.time, dur: 0.5, arc: 0.05, dest: 'table' };
    this.topId = top.id;
    you.hand.forEach((data, i) => {
      const c = this._makeCard(data, 0, { state: 'anim' });
      c.pos.set(DECK_POS.x + rand(-0.02, 0.02), TABLE.y + 0.02, DECK_POS.z + rand(-0.02, 0.02));
      c.quat.copy(new CANNON.Quaternion());
      c.anim = {
        fp: c.pos.clone(),
        fq: c.quat.clone(),
        t0: this.time,
        dur: 0.5,
        arc: 0.18,
        delay: i * 0.06,
        seat: 0,
        dest: 'hand',
      };
      this.hands[0].push(c.id);
    });
    others.forEach((o, oi) => {
      for (let k = 0; k < o.count; k++) {
        const c = this._makeCard(null, o.seat, { state: 'anim' });
        c.pos.set(DECK_POS.x + rand(-0.02, 0.02), TABLE.y + 0.02, DECK_POS.z + rand(-0.02, 0.02));
        c.quat.copy(new CANNON.Quaternion());
        c.anim = {
          fp: c.pos.clone(),
          fq: c.quat.clone(),
          t0: this.time,
          dur: 0.5,
          arc: 0.18,
          delay: 0.3 + oi * 0.1 + k * 0.05,
          seat: o.seat,
          dest: 'hand',
        };
        this.hands[o.seat].push(c.id);
      }
    });
  }

  // The friction solver re-injects a limit-cycle of angular velocity on
  // any card in resting contact (table or pile top). A flying card never
  // dips below ~1.2 m/s until it lands, so a low speed means "at rest"
  // and its spin is pure solver noise.
  _killRestSpin() {
    for (const c of this.cards.values()) {
      if (c.state !== 'flying' || !c.body) continue;
      if (c.body.velocity.length() < 0.15) c.body.angularVelocity.setZero();
    }
  }

  _tidyTop(c) {
    const up = c.quat.vmult(new CANNON.Vec3(0, 0, 1));
    const yaw = Math.atan2(up.x, up.z);
    const tq = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    c.anim = { fp: c.pos.clone(), fq: c.quat.clone(), tq, t0: this.time, dur: 0.55 };
  }

  step(dt) {
    this.time += dt;
    this.liftT += ((this.myTurn ? 1 : 0) - this.liftT) * Math.min(1, dt * 4);
    for (let s = 0; s < 4; s++) this.gesture[s] = Math.max(0, this.gesture[s] - dt / 0.5);
    // two substeps keep a fast toss from tunnelling through the table top;
    // the friction solver re-injects a limit-cycle of angular velocity on
    // cards at rest, so kill it after every substep
    this.world.step(dt / 2);
    this._killRestSpin();
    this.world.step(dt / 2);
    this._killRestSpin();

    for (const c of this.cards.values()) {
      if (c.state === 'held') {
        const idx = this.hands[c.seat].indexOf(c.id);
        const t = this.handSlotTransform(c.seat, idx < 0 ? 0 : idx, this.hands[c.seat].length);
        c.pos.copy(t.p);
        c.quat.copy(t.q);
      } else if (c.state === 'anim' && c.anim) {
        const a = c.anim;
        const k = clamp((this.time - a.t0 - (a.delay || 0)) / a.dur, 0, 1);
        if (k <= 0) continue;
        if (k >= 1) {
          if (a.dest === 'hand') {
            c.state = 'held';
            c.anim = null;
          } else if (a.dest === 'deck') {
            c.state = 'deck';
            this.deckStack.push(c.id);
            const s2 = this.deckSlot(this.deckStack.length - 1, c);
            c.pos.copy(s2.p);
            c.quat.copy(s2.q);
            c.anim = null;
          } else {
            c.state = 'table';
            c.pos.set(DISCARD_POS.x, TABLE.y + PHYS_T / 2, DISCARD_POS.z);
            c.quat.copy(new CANNON.Quaternion());
            c.anim = null;
            const b = this._spawnBody(c);
            b.type = CANNON.Body.KINEMATIC;
            b.velocity.setZero();
            b.angularVelocity.setZero();
            this._tidyTop(c);
          }
          continue;
        }
        const e = easeOutCubic(k);
        let toP, toQ;
        if (a.dest === 'hand') {
          const idx = this.hands[a.seat].indexOf(c.id);
          const t = this.handSlotTransform(a.seat, idx < 0 ? 0 : idx, this.hands[a.seat].length);
          toP = t.p;
          toQ = t.q;
        } else if (a.dest === 'deck') {
          const s2 = this.deckSlot(this.deckStack.length, c);
          toP = s2.p;
          toQ = s2.q;
        } else {
          toP = new CANNON.Vec3(DISCARD_POS.x, TABLE.y + PHYS_T / 2, DISCARD_POS.z);
          toQ = new CANNON.Quaternion();
        }
        const p = new CANNON.Vec3(
          a.fp.x + (toP.x - a.fp.x) * e,
          a.fp.y + (toP.y - a.fp.y) * e + Math.sin(Math.PI * k) * a.arc,
          a.fp.z + (toP.z - a.fp.z) * e
        );
        let q = a.fq.slerp(toQ, e);
        if (a.spin) {
          const qs = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), a.spin * (1 - e));
          q = qs.mult(q);
        }
        c.pos.copy(p);
        c.quat.copy(q);
      } else if (c.state === 'flying' && c.body) {
        const b = c.body;
        c.pos.copy(b.position);
        c.quat.copy(b.quaternion);
        const speed = b.velocity.length() + b.angularVelocity.length();
        if (speed < 0.35) c.rest += dt;
        else c.rest = 0;
        if (c.rest > 2.0) {
          b.type = CANNON.Body.KINEMATIC;
          b.velocity.setZero();
          b.angularVelocity.setZero();
          c.state = 'table';
          c.rest = 0;
          if (c === this.topCard()) this._tidyTop(c);
        }
      } else if (c.state === 'table' && c.body) {
        const b = c.body;
        if (c.anim) {
          const a = c.anim;
          const k = clamp((this.time - a.t0) / a.dur, 0, 1);
          if (k >= 1) {
            c.quat.copy(a.tq);
            c.anim = null;
          } else {
            c.quat.copy(a.fq.slerp(a.tq, easeOutCubic(k)));
          }
          b.quaternion.copy(c.quat);
        } else {
          c.pos.copy(b.position);
          c.quat.copy(b.quaternion);
        }
      }
    }
  }
}

/* ---------- textures (canvas 2D, with headless fallback) ---------- */

function roundRect(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

function drawSkipIcon(x, cx, cy, r) {
  x.strokeStyle = '#fff';
  x.lineWidth = r * 0.28;
  x.lineCap = 'round';
  x.beginPath();
  x.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  x.stroke();
  x.beginPath();
  x.moveTo(cx - r * 0.42, cy + r * 0.42);
  x.lineTo(cx + r * 0.42, cy - r * 0.42);
  x.stroke();
}

function drawReverseIcon(x, cx, cy, r) {
  x.strokeStyle = '#fff';
  x.fillStyle = '#fff';
  x.lineWidth = r * 0.24;
  x.lineCap = 'round';
  x.beginPath();
  x.arc(cx - r * 0.22, cy - r * 0.3, r * 0.5, Math.PI * 0.85, Math.PI * 2.25);
  x.stroke();
  x.beginPath();
  x.arc(cx + r * 0.22, cy + r * 0.3, r * 0.5, Math.PI * -0.15, Math.PI * 1.25);
  x.stroke();
  const t1 = [cx - r * 0.22 + r * 0.5 * Math.cos(Math.PI * 2.25), cy - r * 0.3 + r * 0.5 * Math.sin(Math.PI * 2.25)];
  x.save();
  x.translate(t1[0], t1[1]);
  x.rotate(Math.PI * 2.25 + Math.PI / 2);
  x.beginPath();
  x.moveTo(0, -r * 0.34);
  x.lineTo(r * 0.26, r * 0.1);
  x.lineTo(-r * 0.26, r * 0.1);
  x.closePath();
  x.fill();
  x.restore();
  const t2 = [cx + r * 0.22 + r * 0.5 * Math.cos(Math.PI * 1.25), cy + r * 0.3 + r * 0.5 * Math.sin(Math.PI * 1.25)];
  x.save();
  x.translate(t2[0], t2[1]);
  x.rotate(Math.PI * 1.25 + Math.PI / 2);
  x.beginPath();
  x.moveTo(0, -r * 0.34);
  x.lineTo(r * 0.26, r * 0.1);
  x.lineTo(-r * 0.26, r * 0.1);
  x.closePath();
  x.fill();
  x.restore();
}

function drawWildQuadrants(x, cx, cy, r) {
  const cols = { red: '#e5311b', yellow: '#f2a900', green: '#009a4d', blue: '#0669b0' };
  x.save();
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.clip();
  x.fillStyle = cols.red;
  x.fillRect(cx, cy - r, r, r);
  x.fillStyle = cols.yellow;
  x.fillRect(cx, cy, r, r);
  x.fillStyle = cols.green;
  x.fillRect(cx - r, cy, r, r);
  x.fillStyle = cols.blue;
  x.fillRect(cx - r, cy - r, r, r);
  x.restore();
  x.strokeStyle = 'rgba(255,255,255,0.9)';
  x.lineWidth = r * 0.1;
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.stroke();
}

function glyphFor(x, face, cx, cy, size) {
  x.fillStyle = '#fff';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  if (face.kind === 'number') {
    x.font = `italic 900 ${size}px Archivo, Arial, sans-serif`;
    x.fillText(face.value, cx, cy + size * 0.04);
  } else if (face.kind === 'draw2') {
    x.font = `italic 900 ${size * 0.72}px Archivo, Arial, sans-serif`;
    x.fillText('+2', cx, cy + size * 0.04);
  } else if (face.kind === 'skip') {
    drawSkipIcon(x, cx, cy, size * 0.55);
  } else if (face.kind === 'reverse') {
    drawReverseIcon(x, cx, cy, size * 0.55);
  } else if (face.kind === 'wild') {
    drawWildQuadrants(x, cx, cy, size * 0.55);
  } else if (face.kind === 'wild4') {
    drawWildQuadrants(x, cx, cy, size * 0.55);
    x.fillStyle = '#14161a';
    x.beginPath();
    x.arc(cx, cy, size * 0.34, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#fff';
    x.font = `italic 900 ${size * 0.42}px Archivo, Arial, sans-serif`;
    x.fillText('+4', cx, cy + size * 0.03);
  }
}

function makeFaceTexture(face) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 352;
  const x = c.getContext('2d');
  if (!x) return null;
  roundRect(x, 5, 5, 246, 342, 26);
  x.fillStyle = '#f7f4ec';
  x.fill();
  x.strokeStyle = 'rgba(0,0,0,0.2)';
  x.lineWidth = 3;
  x.stroke();

  const col = COLOR_HEX[face.color] || '#f7f4ec';
  if (face.kind === 'wild' || face.kind === 'wild4') {
    drawWildQuadrants(x, 128, 176, 92);
  } else {
    x.save();
    x.translate(128, 176);
    x.rotate(-0.45);
    x.beginPath();
    x.ellipse(0, 0, 96, 136, 0, 0, Math.PI * 2);
    x.fillStyle = col;
    x.fill();
    x.restore();
    x.save();
    x.translate(128, 176);
    x.rotate(-0.45);
    x.strokeStyle = 'rgba(255,255,255,0.85)';
    x.lineWidth = 7;
    x.beginPath();
    x.ellipse(0, 0, 78, 116, 0, 0, Math.PI * 2);
    x.stroke();
    x.restore();
    glyphFor(x, face, 128, 180, 150);
  }

  // corners
  x.save();
  x.translate(40, 56);
  if (face.kind === 'number') {
    x.fillStyle = '#fff';
    x.font = 'italic 900 52px Archivo, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(face.value, 0, 0);
  } else if (face.kind === 'draw2') {
    x.fillStyle = '#fff';
    x.font = 'italic 900 40px Archivo, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('+2', 0, 0);
  } else if (face.kind === 'wild4') {
    x.fillStyle = '#fff';
    x.font = 'italic 900 40px Archivo, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('+4', 0, 0);
  } else if (face.kind === 'skip') {
    drawSkipIcon(x, 0, 0, 30);
  } else if (face.kind === 'reverse') {
    drawReverseIcon(x, 0, 0, 30);
  } else {
    drawWildQuadrants(x, 0, 0, 30);
  }
  x.restore();
  x.save();
  x.translate(216, 296);
  x.rotate(Math.PI);
  if (face.kind === 'number') {
    x.fillStyle = '#fff';
    x.font = 'italic 900 52px Archivo, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(face.value, 0, 0);
  } else if (face.kind === 'draw2') {
    x.fillStyle = '#fff';
    x.font = 'italic 900 40px Archivo, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('+2', 0, 0);
  } else if (face.kind === 'wild4') {
    x.fillStyle = '#fff';
    x.font = 'italic 900 40px Archivo, Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('+4', 0, 0);
  } else if (face.kind === 'skip') {
    drawSkipIcon(x, 0, 0, 30);
  } else if (face.kind === 'reverse') {
    drawReverseIcon(x, 0, 0, 30);
  } else {
    drawWildQuadrants(x, 0, 0, 30);
  }
  x.restore();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeBackTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 352;
  const x = c.getContext('2d');
  if (!x) return null;
  roundRect(x, 5, 5, 246, 342, 26);
  x.fillStyle = '#232833';
  x.fill();
  x.save();
  roundRect(x, 5, 5, 246, 342, 26);
  x.clip();
  x.strokeStyle = 'rgba(255,255,255,0.05)';
  x.lineWidth = 5;
  for (let i = -352; i < 256 + 352; i += 18) {
    x.beginPath();
    x.moveTo(i, 0);
    x.lineTo(i + 352, 352);
    x.stroke();
  }
  x.restore();
  x.save();
  x.translate(128, 176);
  x.rotate(-0.45);
  x.beginPath();
  x.ellipse(0, 0, 84, 116, 0, 0, Math.PI * 2);
  x.fillStyle = '#e5311b';
  x.fill();
  x.strokeStyle = 'rgba(255,255,255,0.9)';
  x.lineWidth = 6;
  x.beginPath();
  x.ellipse(0, 0, 66, 96, 0, 0, Math.PI * 2);
  x.stroke();
  x.fillStyle = '#fff';
  x.font = 'italic 900 56px Archivo, Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('UNO', 0, 4);
  x.restore();
  x.strokeStyle = 'rgba(0,0,0,0.35)';
  x.lineWidth = 3;
  roundRect(x, 5, 5, 246, 342, 26);
  x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeDecalTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const x = c.getContext('2d');
  if (!x) return null;
  x.clearRect(0, 0, 512, 320);
  x.save();
  x.translate(256, 160);
  x.rotate(-0.06);
  x.fillStyle = '#7e221a';
  x.font = 'italic 900 170px Archivo, Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('UNO', 0, 0);
  x.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- scene construction (no renderer) ---------- */

function buildChair() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.8 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.44), mat);
  seat.position.y = 0.45;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.05), mat);
  back.position.set(0, 0.72, 0.2);
  seat.castShadow = back.castShadow = true;
  g.add(seat, back);
  const legGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.45, 10);
  for (const [lx, lz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) {
    const leg = new THREE.Mesh(legGeo, mat);
    leg.position.set(lx, 0.225, lz);
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

function buildHand(tone) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(tone), roughness: 0.72 });
  const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.036, 0.3), mat);
  forearm.position.set(0, 0.012, -0.17);
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.096, 0.022, 0.1), mat);
  palm.position.set(0, 0.011, 0);
  g.add(forearm, palm);
  const fingerGeo = new THREE.BoxGeometry(0.015, 0.014, 0.058);
  const xs = [-0.033, -0.011, 0.011, 0.033];
  const zs = [0.048, 0.056, 0.056, 0.048];
  xs.forEach((fx, i) => {
    const f = new THREE.Mesh(fingerGeo, mat);
    f.position.set(fx, 0.017, zs[i]);
    f.rotation.x = -0.16;
    g.add(f);
  });
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.014, 0.05), mat);
  thumb.position.set(0.047, 0.017, 0.008);
  thumb.rotation.y = -0.55;
  g.add(thumb);
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return g;
}

export function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080a);
  scene.fog = new THREE.Fog(0x07080a, 5.5, 13);

  scene.add(new THREE.AmbientLight(0x2a3140, 0.5));
  const lamp = new THREE.SpotLight(0xffd2a0, 150, 10, 0.78, 0.5, 1.8);
  lamp.position.set(0, 2.24, 0);
  const lampTarget = new THREE.Object3D();
  lampTarget.position.set(0, 0.77, 0);
  scene.add(lampTarget);
  lamp.target = lampTarget;
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.camera.near = 0.6;
  lamp.shadow.camera.far = 6;
  lamp.shadow.bias = -0.002;
  scene.add(lamp);
  const bulb = new THREE.PointLight(0xffb277, 5, 4, 2);
  bulb.position.set(0, 2.16, 0);
  scene.add(bulb);

  // room
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x171a20, roughness: 0.95 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const wallGeo = new THREE.PlaneGeometry(9, 3.4);
  const mkWall = (px, pz, ry) => {
    const w = new THREE.Mesh(wallGeo, wallMat);
    w.position.set(px, 1.7, pz);
    w.rotation.y = ry;
    w.receiveShadow = true;
    scene.add(w);
  };
  mkWall(0, -4.5, 0);
  mkWall(0, 4.5, Math.PI);
  mkWall(-4.5, 0, Math.PI / 2);
  mkWall(4.5, 0, -Math.PI / 2);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 1 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3.4;
  scene.add(ceiling);

  const decal = makeDecalTexture();
  if (decal) {
    const d = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.56),
      new THREE.MeshBasicMaterial({ map: decal, transparent: true, opacity: 0.55 })
    );
    d.position.set(0, 2.15, -4.49);
    scene.add(d);
  }

  // table
  const wood = new THREE.MeshStandardMaterial({ color: 0x53381f, roughness: 0.48, metalness: 0.05 });
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x3a2614, roughness: 0.6 });
  const topMesh = new THREE.Mesh(new THREE.BoxGeometry(TABLE.size, 0.045, TABLE.size), wood);
  topMesh.position.y = TABLE.y - 0.0225;
  topMesh.castShadow = true;
  topMesh.receiveShadow = true;
  scene.add(topMesh);
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.size - 0.12, 0.004, TABLE.size - 0.12),
    new THREE.MeshStandardMaterial({ color: 0x46301b, roughness: 0.85 })
  );
  panel.position.y = TABLE.y - 0.002;
  panel.receiveShadow = true;
  scene.add(panel);
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.68, 20), woodDark);
  ped.position.y = 0.36;
  ped.castShadow = true;
  scene.add(ped);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.035, 24), woodDark);
  base.position.y = 0.0175;
  base.castShadow = true;
  scene.add(base);

  // hanging lamp
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.0, 8), new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.8 }));
  cord.position.y = 2.9;
  scene.add(cord);
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x23372b, roughness: 0.4, metalness: 0.35, side: THREE.DoubleSide });
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.24, 0.18, 32, 1, true), shadeMat);
  shade.position.y = 2.33;
  scene.add(shade);
  const trim = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.008, 8, 40), new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.35, metalness: 0.65 }));
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 2.24;
  scene.add(trim);
  const bulbMesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffd9a8, emissiveIntensity: 3.2 }));
  bulbMesh.position.y = 2.22;
  scene.add(bulbMesh);

  // current-color ring at the table rim
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.585, 0.0045, 10, 72),
    new THREE.MeshBasicMaterial({ color: 0xe5311b, transparent: true, opacity: 0.5 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = TABLE.y + 0.0035;
  scene.add(ring);

  // gold ring on the discard's top card
  const topRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.052, 0.0035, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.85 })
  );
  topRing.visible = false;
  scene.add(topRing);

  // seats + hands
  const seats = [];
  for (let s = 0; s < 4; s++) {
    const u = SEAT_UNITS[s];
    const chair = buildChair();
    chair.position.set(u.x * SEAT_R, 0, u.z * SEAT_R);
    chair.rotation.y = Math.atan2(u.x, u.z);
    scene.add(chair);
    const f = new THREE.Vector3(-u.x, 0, -u.z);
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const hand = buildHand(SKIN_TONES[s]);
    hand.position.set(u.x * HAND_R, TABLE.y, u.z * HAND_R);
    hand.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, new THREE.Vector3(0, 1, 0), f));
    scene.add(hand);
    seats.push({ chair, hand, baseQ: hand.quaternion.clone() });
  }

  const cardsGroup = new THREE.Group();
  scene.add(cardsGroup);

  return { scene, ring, topRing, seats, cardsGroup, lamp, bulb };
}

/* ---------- full table: renderer + loop + input + labels ---------- */

export function createTable3D(container, { onCardClick, onDeckClick, labels } = {}) {
  const sim = new CardSim();
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const { scene, ring, topRing, seats, cardsGroup } = buildScene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 40);

  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf2eee3, roughness: 0.55 });
  const cardGeo = new THREE.BoxGeometry(CARD.w, CARD.t, CARD.h);
  const backTex = makeBackTexture();
  const backMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.42, color: backTex ? 0xffffff : 0x232833 });
  const faceMatCache = new Map();
  const texKey = (face) => `${face.kind}-${face.value || ''}-${face.color || ''}`;
  function faceMat(face) {
    const k = texKey(face);
    if (!faceMatCache.has(k)) {
      const t = makeFaceTexture(face);
      faceMatCache.set(
        k,
        new THREE.MeshStandardMaterial({ map: t, roughness: 0.38, color: t ? 0xffffff : new THREE.Color(COLOR_HEX[face.color] || '#e5311b') })
      );
    }
    return faceMatCache.get(k);
  }

  // seat labels (DOM overlay, projected each frame)
  const labelEls = [null, null, null, null];
  function setLabel(seat, p) {
    if (!labels) return;
    let el = labelEls[seat];
    if (!el) {
      el = document.createElement('div');
      el.className = 'seat-label';
      el.innerHTML = '<span class="s-name"></span><span class="s-count"></span>';
      labels.appendChild(el);
      labelEls[seat] = el;
    }
    el._on = true;
    el.querySelector('.s-name').textContent = `${p.name}${p.isBot ? ' · bot' : ''}`;
    el.querySelector('.s-count').textContent = p.handCount;
    el.classList.toggle('current', !!p.isCurrent);
    el.classList.toggle('off', !!p.disconnected);
  }
  function hideLabel(seat) {
    if (labelEls[seat]) labelEls[seat]._on = false;
  }

  // camera
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const camBase = { pos: new THREE.Vector3(0, 1.44, 2.08), look: new THREE.Vector3(0, 0.82, -0.05) };
  const camLean = { pos: new THREE.Vector3(0, 1.27, 1.7), look: new THREE.Vector3(0, 0.79, -0.12) };
  const curPos = camBase.pos.clone();
  const curLook = camBase.look.clone();
  const tmpV = new THREE.Vector3();

  // interaction
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerIn = false;
  let hoveredId = null;
  let deckHot = false;
  const deckHit = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.2), new THREE.MeshBasicMaterial({ visible: false }));
  deckHit.position.set(DECK_POS.x, TABLE.y + 0.04, DECK_POS.z);
  scene.add(deckHit);
  const el = renderer.domElement;
  el.addEventListener('pointermove', (e) => {
    pointerIn = true;
    const r = el.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  });
  el.addEventListener('pointerleave', () => {
    pointerIn = false;
  });
  el.addEventListener('click', () => {
    if (hoveredId && onCardClick) onCardClick(hoveredId);
    else if (deckHot && onDeckClick) onDeckClick();
  });

  // card meshes
  const meshByCard = new Map();
  function reconcile() {
    for (const [id, m] of [...meshByCard]) {
      if (!sim.cards.has(id)) {
        cardsGroup.remove(m);
        meshByCard.delete(id);
      }
    }
    for (const c of sim.cards.values()) {
      if (meshByCard.has(c.id)) continue;
      const m = new THREE.Mesh(cardGeo, [edgeMat, edgeMat, backMat, backMat, edgeMat, edgeMat]);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.id = c.id;
      m.userData.matKey = '';
      cardsGroup.add(m);
      meshByCard.set(c.id, m);
    }
  }

  let ringPulse = 0;
  let last = 0;
  let acc = 0;
  const STEP = 1 / 60;
  let raf = 0;

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 4) {
      sim.step(STEP);
      acc -= STEP;
      n++;
    }
    reconcile();

    if (pointerIn) {
      raycaster.setFromCamera(pointer, camera);
      const myCards = [];
      for (const c of sim.cards.values()) {
        if (c.seat === 0 && (c.state === 'held' || c.state === 'anim')) myCards.push(meshByCard.get(c.id));
      }
      const hit = raycaster.intersectObjects(myCards.filter(Boolean), false);
      hoveredId = hit.length ? hit[0].object.userData.id : null;
      deckHot = raycaster.intersectObject(deckHit, false).length > 0;
    }
    el.style.cursor = hoveredId || deckHot ? 'pointer' : 'default';

    for (const [id, c] of sim.cards) {
      const m = meshByCard.get(id);
      if (!m) continue;
      m.position.set(c.pos.x, c.pos.y, c.pos.z);
      m.quaternion.set(c.quat.x, c.quat.y, c.quat.z, c.quat.w);
      const key = c.face ? texKey(c.face) : 'back';
      if (m.userData.matKey !== key) {
        m.material[2] = c.face ? faceMat(c.face) : backMat;
        m.material[3] = backMat;
        m.userData.matKey = key;
      }
      if (c.seat === 0 && (c.state === 'held' || c.state === 'anim')) {
        const t = hoveredId === c.id ? 1 : 0;
        c._hover += (t - c._hover) * 0.25;
        if (c._hover > 0.01) m.position.y += c._hover * 0.028;
      }
    }

    const topC = sim.topCard();
    if (topC && (topC.state === 'table' || topC.state === 'flying' || topC.state === 'anim')) {
      topRing.visible = true;
      topRing.position.set(topC.pos.x, topC.pos.y + 0.004, topC.pos.z);
      topRing.quaternion.set(topC.quat.x, topC.quat.y, topC.quat.z, topC.quat.w);
      topRing.rotateX(Math.PI / 2);
    } else {
      topRing.visible = false;
    }

    for (let s = 0; s < 4; s++) {
      const g = sim.gesture[s];
      seats[s].hand.quaternion.copy(seats[s].baseQ);
      if (g > 0.001) {
        const qg = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.38 * Math.sin(Math.PI * (1 - g)));
        seats[s].hand.quaternion.multiply(qg);
      }
    }

    const target = !reduced && sim.myTurn ? camLean : camBase;
    const off = camera.aspect < 0.8 ? 0.55 : 0;
    const k = 1 - Math.exp(-dt * 3.4);
    tmpV.set(target.pos.x, target.pos.y, target.pos.z + off);
    curPos.lerp(tmpV, k);
    curLook.lerp(target.look, k);
    camera.position.copy(curPos);
    camera.lookAt(curLook);

    ringPulse = Math.max(0, ringPulse - dt * 2);
    ring.scale.setScalar(1 + 0.05 * ringPulse);

    if (labels) {
      const r = container.getBoundingClientRect();
      const v = new THREE.Vector3();
      for (let s = 1; s < 4; s++) {
        const le = labelEls[s];
        if (!le) continue;
        if (!le._on) {
          le.style.display = 'none';
          continue;
        }
        const u = SEAT_UNITS[s];
        v.set(u.x * HAND_R, TABLE.y + 0.3, u.z * HAND_R).project(camera);
        if (v.z > 1 || v.z < -1) {
          le.style.display = 'none';
          continue;
        }
        le.style.display = '';
        le.style.transform = `translate(${(((v.x + 1) / 2) * r.width).toFixed(1)}px, ${(((1 - v.y) / 2) * r.height).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(loop);

  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 0.8 ? 64 : 55;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  function sync(st, prev) {
    const seatOf = (idx) => seatFor(idx, st.yourIndex, st.players);
    if (st.status === 'playing') {
      const fresh = !prev || prev.status !== 'playing';
      if (fresh) {
        const others = st.players.filter((p) => p.index !== st.yourIndex).sort((a, b) => a.index - b.index);
        const fill = OPP_FILL[others.length] || [1];
        sim.deal({
          you: { seat: 0, hand: st.yourHand || [] },
          others: others.map((p, i) => ({ seat: fill[i], count: p.handCount })),
          deckCount: st.deckCount,
          top: st.top,
        });
      } else {
        const topChanged = !!(st.top && prev.top && st.top.id !== prev.top.id);
        if (topChanged) {
          const actor = prev.turn;
          if (actor === st.yourIndex) {
            sim.releaseIfHeld(st.top.id);
            sim.triggerGesture(0);
          } else {
            sim.opponentPlays(seatOf(actor), st.top);
            sim.triggerGesture(seatOf(actor));
          }
        }
        if (prev.yourHand) {
          const curIds = new Set(st.yourHand.map((c) => c.id));
          const prevIds = new Set(prev.yourHand.map((c) => c.id));
          for (const c of st.yourHand) {
            if (prevIds.has(c.id)) continue;
            const sc = sim.cards.get(c.id);
            if (!sc) sim.drawInto(0, c);
            else if (sc.state === 'flying' || sc.state === 'table' || sc.state === 'deck') sim.recall(c.id, 0);
          }
          while (sim.handCount(0) > st.yourHand.length) {
            const extraId = sim.hands[0].find((id) => !curIds.has(id));
            if (extraId == null) break;
            sim.releaseCard(extraId);
          }
        }
        for (const p of st.players) {
          if (p.index === st.yourIndex) continue;
          const seat = seatOf(p.index);
          const d = p.handCount - sim.handCount(seat);
          if (d > 0) for (let i = 0; i < d; i++) sim.drawInto(seat, null);
          else if (d < 0) for (let i = 0; i < -d; i++) sim.discardBack(seat);
        }
        sim.setDeckCount(st.deckCount);
      }
      sim.setTop(st.top ? st.top.id : null);
      sim.myTurn = st.turn === st.yourIndex;
      const used = new Set([0]);
      for (const p of st.players) {
        const seat = seatOf(p.index);
        used.add(seat);
        if (seat === 0) continue;
        setLabel(seat, p);
      }
      for (let s = 1; s < 4; s++) if (!used.has(s)) hideLabel(s);
      const color = COLOR_HEX[st.currentColor];
      if (color) {
        ring.material.color.set(color);
        ringPulse = 1;
      }
    } else if (st.status === 'over') {
      sim.myTurn = false;
    }
  }

  return {
    sim,
    sync,
    reshuffle: () => {
      if (sim.topId) sim.reshuffle(sim.topId);
    },
    setOver: () => {
      sim.myTurn = false;
    },
    reset: () => {
      sim.reset();
      for (let s = 1; s < 4; s++) hideLabel(s);
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      container.innerHTML = '';
    },
  };
}
