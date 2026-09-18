import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../lib/game.js';

function setup(n = 2, turn = 0) {
  const g = new Game();
  for (let i = 0; i < n; i++) g.addPlayer(`P${i}`);
  g.start();
  g.direction = 1;
  g.turn = turn;
  g.discard = [{ id: 'top', color: 'red', value: '7', kind: 'number' }];
  g.currentColor = 'red';
  return g;
}

test('deck has all 108 cards', () => {
  const g = new Game();
  g.addPlayer('A');
  g.addPlayer('B');
  g.start();
  const all = [...g.players.flatMap((p) => p.hand), ...g.deck, ...g.discard];
  assert.equal(all.length, 108);
  const wilds = all.filter((c) => c.color === 'wild');
  assert.equal(wilds.length, 8);
});

test('matching by color, value, or wild is accepted; mismatch rejected', () => {
  const g = setup();
  g.players[0].hand = [
    { id: 'a', color: 'red', value: '3', kind: 'number' },
    { id: 'b', color: 'blue', value: '7', kind: 'number' },
    { id: 'c', color: 'green', value: '9', kind: 'number' },
    { id: 'w', color: 'wild', value: 'wild', kind: 'wild' },
  ];
  assert.equal(g.isPlayable(g.players[0].hand[0]), true);
  assert.equal(g.isPlayable(g.players[0].hand[1]), true);
  assert.equal(g.isPlayable(g.players[0].hand[2]), false);
  assert.equal(g.isPlayable(g.players[0].hand[3]), true);
});

test('wild4 is illegal while holding a card of the current color', () => {
  const g = setup();
  const w4 = { id: 'w4', color: 'wild', value: 'wild4', kind: 'wild4' };
  g.players[0].hand = [w4, { id: 'r', color: 'red', value: '3', kind: 'number' }];
  assert.equal(g.isPlayable(w4, g.players[0].hand), false);
  g.players[0].hand = [w4];
  assert.equal(g.isPlayable(w4, g.players[0].hand), true);
});

test('skip passes the next seat', () => {
  const g = setup(3);
  g.players[0].hand = [{ id: 's', color: 'red', value: 'skip', kind: 'skip' }];
  const res = g.playCard(0, 's');
  assert.equal(res.ok, true);
  assert.equal(g.turn, 2);
});

test('reverse flips direction and acts as skip with two players', () => {
  const g = setup(2);
  g.players[0].hand = [{ id: 'r', color: 'red', value: 'reverse', kind: 'reverse' }];
  const before = g.direction;
  g.playCard(0, 'r');
  assert.equal(g.direction, -before);
  assert.equal(g.turn, 0);

  // With 3 players the turn now moves against the flipped direction, so to the seat "behind".
  const g3 = setup(3);
  g3.players[0].hand = [{ id: 'r', color: 'red', value: 'reverse', kind: 'reverse' }];
  const dirBefore = g3.direction;
  g3.playCard(0, 'r');
  assert.equal(g3.direction, -dirBefore);
  assert.equal(g3.turn, 2);
});

test('draw2 and wild4 hit the next player and skip their turn', () => {
  // draw2 is a colored card, so it takes over its own color; wild4 (color 'wild') honors the chosen color.
  for (const [kind, value, n, cardColor, expectedColor] of [
    ['draw2', 'draw2', 2, 'red', 'red'],
    ['wild4', 'wild4', 4, 'wild', 'blue'],
  ]) {
    const g = setup(3);
    const before = g.players[1].hand.length;
    g.players[0].hand = [{ id: 'x', color: cardColor, value, kind }];
    const res = g.playCard(0, 'x', 'blue');
    assert.equal(res.ok, true);
    assert.equal(res.penalty, n);
    assert.equal(g.players[1].hand.length, before + n);
    assert.equal(g.turn, 2);
    assert.equal(g.currentColor, expectedColor);
  }
});

test('forgetting UNO costs two cards; calling it wins the game', () => {
  const g1 = setup();
  g1.players[0].hand = [{ id: 'g7', color: 'red', value: '7', kind: 'number' }];
  g1.players[0].unoCalled = false;
  const r1 = g1.playCard(0, 'g7');
  assert.equal(r1.unoPenalty, true);
  assert.equal(g1.status, 'playing');
  assert.equal(g1.players[0].hand.length, 2);

  const g2 = setup();
  g2.players[0].hand = [{ id: 'g7', color: 'red', value: '7', kind: 'number' }];
  g2.players[0].unoCalled = true;
  const r2 = g2.playCard(0, 'g7');
  assert.equal(r2.ok, true);
  assert.equal(g2.status, 'over');
  assert.equal(g2.winner, 0);
});

test('can only act on your own turn, once per draw', () => {
  const g = setup(2);
  g.players[1].hand = [{ id: 'x', color: 'red', value: '7', kind: 'number' }];
  assert.equal(g.playCard(1, 'x').ok, false);
  assert.equal(g.draw(1).ok, false);
  assert.equal(g.pass(0).ok, false);
  const d = g.draw(0);
  assert.equal(d.ok, true);
  assert.equal(g.draw(0).ok, false);
  assert.equal(g.pass(0).ok, true);
  assert.equal(g.turn, 1);
});

test('empty deck reshuffles the discard pile, keeping the top card', () => {
  const g = setup(2);
  const topCard = { id: 'top', color: 'red', value: '7', kind: 'number' };
  g.deck = [];
  g.discard = [
    { id: 'c1', color: 'blue', value: '2', kind: 'number' },
    { id: 'c2', color: 'green', value: '5', kind: 'number' },
    topCard, // top of the pile is the last element
  ];
  const res = g.draw(0);
  assert.equal(res.ok, true);
  // The two non-top cards were recycled into the deck; the top card stays on top.
  assert.equal(g.discard.length, 1);
  assert.equal(g.discard[0], topCard);
  assert.equal(g.deck.length, 1);
});
