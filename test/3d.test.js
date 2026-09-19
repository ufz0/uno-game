import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CANNON from 'cannon-es';
import { CardSim, buildScene, seatFor } from '../public/table3d.js';

const STEP = 1 / 60;
const UP = new CANNON.Vec3(0, 1, 0);

const mkCard = (id, color = 'red', value = '1', kind = 'number') => ({ id, color, value, kind });
const PLAYERS4 = [
  { index: 0, name: 'You' },
  { index: 1, name: 'A' },
  { index: 2, name: 'B' },
  { index: 3, name: 'C' },
];

function stepFor(sim, seconds) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) sim.step(STEP);
}

function freshSim() {
  const sim = new CardSim();
  const hand = Array.from({ length: 7 }, (_, i) => mkCard(`y${i}`, 'red', String(i % 10)));
  sim.deal({
    you: { seat: 0, hand },
    others: [{ seat: 1, count: 7 }],
    deckCount: 45,
    top: mkCard('t0'),
  });
  stepFor(sim, 2.5); // let the deal animation finish
  return sim;
}

test('seatFor maps opponents to seats by table size', () => {
  assert.equal(seatFor(0, 0, PLAYERS4), 0);
  const two = [PLAYERS4[0], PLAYERS4[1]];
  assert.equal(seatFor(1, 0, two), 1);
  const three = [PLAYERS4[0], PLAYERS4[1], PLAYERS4[2]];
  assert.deepEqual(
    three.filter((p) => p.index !== 0).map((p) => seatFor(p.index, 0, three)),
    [2, 3]
  );
  assert.deepEqual(
    PLAYERS4.filter((p) => p.index !== 0).map((p) => seatFor(p.index, 0, PLAYERS4)),
    [1, 2, 3]
  );
});

test('deal builds hands, deck and top card; orientations are correct', () => {
  const sim = freshSim();
  assert.equal(sim.handCount(0), 7);
  assert.equal(sim.handCount(1), 7);
  assert.equal(sim.deckStack.length, 45);
  assert.equal(sim.topId, 't0');
  assert.equal(sim.cards.size, 7 + 7 + 45 + 1);

  let n = sim.cards.get('y3').quat.vmult(UP);
  assert.ok(n.y > 0.9, `your cards face up, got ${n.y.toFixed(2)}`);
  n = sim.cards.get(sim.hands[1][3]).quat.vmult(UP);
  assert.ok(n.y < -0.9, `opponent cards face down, got ${n.y.toFixed(2)}`);

  const top = sim.cards.get('t0');
  assert.equal(top.state, 'table');
  assert.ok(top.pos.y > 0.77 && top.pos.y < 0.8);
});

test('a played card is tossed, lands on the table and freezes', () => {
  const sim = freshSim();
  sim.releaseCard('y3');
  assert.equal(sim.handCount(0), 6);
  assert.equal(sim.cards.get('y3').state, 'flying');
  stepFor(sim, 3.5);
  const c = sim.cards.get('y3');
  assert.equal(c.state, 'table');
  assert.ok(c.pos.y > 0.76 && c.pos.y < 0.83, `landed on the table, y=${c.pos.y.toFixed(3)}`);
  assert.ok(Math.abs(c.pos.x) < 0.66, `x within table, got ${c.pos.x.toFixed(2)}`);
  assert.ok(Math.abs(c.pos.z) < 0.66, `z within table, got ${c.pos.z.toFixed(2)}`);
});

test('opponent play reveals the new top and flips it face up', () => {
  const sim = freshSim();
  const before = sim.hands[1].slice();
  sim.opponentPlays(1, mkCard('t1'));
  sim.setTop('t1');
  assert.equal(sim.handCount(1), 6);
  const played = sim.cards.get(before[3]);
  assert.equal(played.face.id, 't1', 'the played card is revealed');
  assert.equal(played.state, 'flying');
  stepFor(sim, 4);
  assert.equal(played.state, 'table');
  assert.ok(played.pos.y > 0.76 && played.pos.y < 0.85, `on the table, y=${played.pos.y.toFixed(3)}`);
  const n = played.quat.vmult(UP);
  assert.ok(n.y > 0.5, `top card settles face up, got ${n.y.toFixed(2)}`);
});

test('draw arcs a deck card into the hand', () => {
  const sim = freshSim();
  sim.drawInto(1, null);
  assert.equal(sim.handCount(1), 8);
  assert.equal(sim.deckStack.length, 44);
  stepFor(sim, 1.2);
  const last = sim.hands[1][7];
  assert.equal(sim.cards.get(last).state, 'held');
});

test('a rejected play recalls the card back to the hand', () => {
  const sim = freshSim();
  sim.releaseCard('y3');
  stepFor(sim, 0.3);
  sim.recall('y3', 0);
  stepFor(sim, 1.2);
  assert.equal(sim.cards.get('y3').state, 'held');
  assert.equal(sim.handCount(0), 7);
});

test('setDeckCount reconciles the stack', () => {
  const sim = freshSim();
  sim.setDeckCount(30);
  assert.equal(sim.deckStack.length, 30);
  sim.setDeckCount(50);
  assert.equal(sim.deckStack.length, 50);
  assert.equal(sim.cards.size, 7 + 7 + 50 + 1);
});

test('reshuffle sweeps the pile into the deck and keeps the top', () => {
  const sim = freshSim();
  sim.releaseCard('y0');
  stepFor(sim, 3.5);
  sim.releaseCard('y1');
  stepFor(sim, 3.5);
  assert.equal(sim.cards.get('y0').state, 'table');
  sim.setTop('y1');
  sim.reshuffle('y1');
  stepFor(sim, 4);
  assert.equal(sim.cards.get('y0').state, 'deck');
  assert.ok(sim.deckStack.includes('y0'));
  assert.equal(sim.cards.get('y1').state, 'table', 'the top card stays');
});

test('a pile of played cards stays on the table', () => {
  const sim = freshSim();
  for (let i = 0; i < 7; i++) {
    sim.releaseCard(`y${i}`);
    stepFor(sim, 1.2);
  }
  stepFor(sim, 3);
  for (let i = 0; i < 7; i++) {
    const c = sim.cards.get(`y${i}`);
    assert.equal(c.state, 'table', `y${i} settled`);
    assert.ok(c.pos.y > 0.75, `y${i} on the table, y=${c.pos.y.toFixed(3)}`);
    assert.ok(Math.abs(c.pos.x) < 0.68, `y${i} x in bounds, got ${c.pos.x.toFixed(2)}`);
    assert.ok(Math.abs(c.pos.z) < 0.68, `y${i} z in bounds, got ${c.pos.z.toFixed(2)}`);
  }
  assert.equal(sim.deckStack.length, 45, 'the deck is untouched');
});

test('buildScene constructs room, table, seats and hands', () => {
  const { scene, seats, cardsGroup } = buildScene();
  assert.equal(seats.length, 4);
  let meshes = 0;
  scene.traverse((o) => {
    if (o.isMesh) meshes++;
  });
  assert.ok(meshes >= 15, `scene has meshes, got ${meshes}`);
  assert.equal(cardsGroup.children.length, 0);
});
