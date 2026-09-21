import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, shuffle, isWild } from '../lib/cards.js';

test('buildDeck returns the full 108-card composition', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);

  const by = (color, value, kind) =>
    deck.filter((c) => c.color === color && c.value === value && c.kind === kind).length;

  for (const color of ['red', 'yellow', 'green', 'blue']) {
    assert.equal(by(color, '0', 'number'), 1, `${color} has one 0`);
    for (let n = 1; n <= 9; n++) {
      assert.equal(by(color, String(n), 'number'), 2, `${color} has two ${n}s`);
    }
    assert.equal(by(color, 'skip', 'skip'), 2, `${color} has two skips`);
    assert.equal(by(color, 'reverse', 'reverse'), 2, `${color} has two reverses`);
    assert.equal(by(color, 'draw2', 'draw2'), 2, `${color} has two draw2s`);
  }
  assert.equal(by('wild', 'wild', 'wild'), 4, 'four plain wilds');
  assert.equal(by('wild', 'wild4', 'wild4'), 4, 'four wild4s');
});

test('every card in a built deck has a unique id', () => {
  const deck = buildDeck();
  const ids = new Set(deck.map((c) => c.id));
  assert.equal(ids.size, deck.length, 'no duplicate card ids');
});

test('shuffle is a permutation of the input and mutates in place', () => {
  const arr = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const snapshot = [...arr];
  const returned = shuffle(arr);
  assert.equal(returned, arr, 'shuffle returns the same array (in place)');
  assert.deepEqual([...arr].sort(), [...snapshot].sort(), 'same elements, no loss');
});

test('shuffle actually reorders (non-identity) with high probability', () => {
  // 8 distinct elements: a single random shuffle leaving the order unchanged is 1/40320.
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  let moved = false;
  for (let i = 0; i < 5 && !moved; i++) {
    const before = [...arr];
    shuffle(arr);
    moved = arr.some((v, idx) => v !== before[idx]);
  }
  assert.ok(moved, 'at least one of five shuffles changed the order');
});

test('isWild recognises wild and wild4, and nothing else', () => {
  assert.equal(isWild({ kind: 'wild' }), true);
  assert.equal(isWild({ kind: 'wild4' }), true);
  assert.equal(isWild({ kind: 'number' }), false);
  assert.equal(isWild({ kind: 'skip' }), false);
  assert.equal(isWild({ kind: 'reverse' }), false);
  assert.equal(isWild({ kind: 'draw2' }), false);
});
