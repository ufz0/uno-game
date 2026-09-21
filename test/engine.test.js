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

test('callUno accepts exactly one card left, and nothing else', () => {
  const g = setup();
  g.players[0].hand = [{ id: 'a', color: 'red', value: '3', kind: 'number' }];
  assert.equal(g.callUno(0).ok, true);
  assert.equal(g.players[0].unoCalled, true);

  g.players[0].hand = [];
  const zero = g.callUno(0);
  assert.equal(zero.ok, false);
  assert.match(zero.error, /one card/);

  g.players[0].hand = [
    { id: 'a', color: 'red', value: '3', kind: 'number' },
    { id: 'b', color: 'red', value: '4', kind: 'number' },
  ];
  assert.equal(g.callUno(0).ok, false, 'two cards left is not the moment to shout');

  const missing = g.callUno(99);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no such player/i);
});

test('canStart enforces the 2-10 player window', () => {
  const g = new Game();
  g.addPlayer('P');
  assert.equal(g.canStart(), false, 'one player is not enough');
  g.addPlayer('Q');
  assert.equal(g.canStart(), true, 'two players is the minimum');
  while (g.players.length < 10) g.addPlayer('P');
  assert.equal(g.canStart(), true, 'ten players is allowed');
  g.addPlayer('P');
  assert.equal(g.canStart(), false, 'eleven players is too many');
});

test('start() requires 2-10 players and never opens with a wild', () => {
  const solo = new Game();
  solo.addPlayer('Solo');
  assert.throws(() => solo.start(), /2-10 players/);

  for (let trial = 0; trial < 25; trial++) {
    const g = new Game();
    g.addPlayer('A');
    g.addPlayer('B');
    g.start();
    assert.notEqual(g.top.kind, 'wild', `trial ${trial}: first card is not a wild`);
    assert.notEqual(g.top.kind, 'wild4', `trial ${trial}: first card is not a wild4`);
  }
});

test('top is null while the discard is empty, else the last card', () => {
  const g = new Game();
  g.addPlayer('A');
  g.addPlayer('B');
  g.start();
  const saved = [...g.discard];
  assert.ok(g.top, 'a started game always has a top card');
  g.discard = [];
  assert.equal(g.top, null);
  g.discard = saved;
  assert.equal(g.top, saved[saved.length - 1]);
});

test('nextIndex and advance honour a reversed direction and wrap around', () => {
  const g = new Game();
  for (let i = 0; i < 4; i++) g.addPlayer(`P${i}`);
  g.start();
  g.turn = 0;
  g.direction = 1;
  assert.equal(g.nextIndex(1), 1);
  g.direction = -1;
  assert.equal(g.nextIndex(1), 3, 'reversed: the next seat wraps to the previous one');
  g.advance(1);
  assert.equal(g.turn, 3);
  g.advance(1);
  assert.equal(g.turn, 2, 'keeps moving against the reversed direction');
});

test('removePlayer splices the seat and playerIndexById resolves by id', () => {
  const g = new Game();
  const i0 = g.addPlayer('A');
  const i1 = g.addPlayer('B');
  const i2 = g.addPlayer('C');
  assert.equal(i0, 0);
  assert.equal(g.playerIndexById(g.players[i1].id), i1);
  g.removePlayer(i1);
  assert.equal(g.players.length, 2);
  assert.equal(g.players[0].name, 'A');
  assert.equal(g.players[1].name, 'C', 'seats reindex after removal');
  assert.equal(g.playerIndexById(g.players[1].id), 1);
  assert.equal(g.playerIndexById('does-not-exist'), -1);
});

test('reset() returns to the lobby and clears all game state', () => {
  const g = new Game();
  g.addPlayer('A');
  g.addPlayer('B');
  g.start();
  g.players[0].unoCalled = true;
  g.players[0].disconnected = true;
  g.winner = 0;
  g.reset();
  assert.equal(g.status, 'lobby');
  assert.equal(g.deck.length, 0);
  assert.equal(g.discard.length, 0);
  assert.equal(g.winner, null);
  assert.equal(g.currentColor, null);
  assert.equal(g.players[0].hand.length, 0);
  assert.equal(g.players[0].unoCalled, false);
  assert.equal(g.players[0].disconnected, false);
});

test('playing a wild requires a legal chosen color', () => {
  const g = setup();
  const w = { id: 'w', color: 'wild', value: 'wild', kind: 'wild' };
  g.players[0].hand = [w];
  const noColor = g.playCard(0, 'w');
  assert.equal(noColor.ok, false);
  assert.match(noColor.error, /color/);
  const badColor = g.playCard(0, 'w', 'purple');
  assert.equal(badColor.ok, false);
  assert.equal(g.players[0].hand.length, 1, 'a rejected wild is not consumed');
});

test('playCard rejects an unknown card, the wrong turn, and a finished game', () => {
  const g = setup();
  g.players[0].hand = [{ id: 'a', color: 'red', value: '3', kind: 'number' }];
  assert.match(g.playCard(0, 'nope').error, /not in hand/i);
  assert.match(g.playCard(1, 'a').error, /not your turn/i);
  g.status = 'over';
  assert.match(g.playCard(0, 'a').error, /not in progress/i);
});

test('skip with two players returns the turn to the player', () => {
  const g = setup(2);
  g.players[0].hand = [{ id: 's', color: 'red', value: 'skip', kind: 'skip' }];
  const res = g.playCard(0, 's');
  assert.equal(res.ok, true);
  assert.equal(g.turn, 0, 'two-player skip sends the turn straight back');
});

test('reverse with four players sends the turn the long way round', () => {
  const g = setup(4, 0);
  g.players[0].hand = [{ id: 'r', color: 'red', value: 'reverse', kind: 'reverse' }];
  const dirBefore = g.direction;
  g.playCard(0, 'r');
  assert.equal(g.direction, -dirBefore);
  assert.equal(g.turn, 3, 'against the reversed direction the turn lands on seat 3');
});

test('pass requires a draw first; draw rejects the wrong turn and a finished game', () => {
  const g = setup(2);
  const noDraw = g.pass(0);
  assert.equal(noDraw.ok, false);
  assert.match(noDraw.error, /draw a card first/i);

  assert.match(g.draw(1).error, /not your turn/i);
  g.status = 'over';
  assert.match(g.draw(0).error, /not in progress/i);
});

test('a card matches the top by value even in another color', () => {
  const g = setup(); // top is a red 7
  const blue7 = { id: 'b7', color: 'blue', value: '7', kind: 'number' };
  g.players[0].hand = [blue7];
  assert.equal(g.isPlayable(blue7), true, 'a blue 7 matches the red 7 by value');
  const res = g.playCard(0, 'b7');
  assert.equal(res.ok, true);
  assert.equal(g.currentColor, 'blue', 'playing it flips the current color');
});

test('a draw2 played as the final card still deals its penalty', () => {
  const g = setup(3);
  g.players[0].hand = [{ id: 'd2', color: 'red', value: 'draw2', kind: 'draw2' }];
  g.players[0].unoCalled = true;
  const before = g.players[1].hand.length;
  const res = g.playCard(0, 'd2');
  assert.equal(res.ok, true);
  assert.equal(res.penalty, 2, 'the draw2 effect resolved');
  assert.equal(g.players[1].hand.length, before + 2);
  assert.equal(g.status, 'over', 'it was the last card, so the game ends');
  assert.equal(g.winner, 0);
});

test('playing any card clears the drewThisTurn flag', () => {
  const g = setup(2);
  g.draw(0);
  assert.equal(g.drewThisTurn, true);
  g.players[0].hand.push({ id: 'r3', color: 'red', value: '3', kind: 'number' });
  g.playCard(0, 'r3');
  assert.equal(g.drewThisTurn, false);
});
