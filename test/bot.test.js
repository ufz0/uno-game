import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../lib/game.js';
import { botMove } from '../lib/bot.js';

// A two-seat game where seat 0 (the bot) is on turn, with a controlled hand,
// top card and (where relevant) draw pile.
function botGame({ hand, top, deck = [] }) {
  const g = new Game();
  g.addPlayer('Bot');
  g.addPlayer('Human');
  g.start();
  g.direction = 1;
  g.turn = 0;
  g.discard = [top];
  g.currentColor = top.color;
  g.players[0].hand = hand;
  g.players[1].hand = [{ id: 'h1', color: 'red', value: '7', kind: 'number' }];
  if (deck.length) g.deck = deck;
  return g;
}

const card = (id, color, value, kind = 'number') => ({ id, color, value, kind });

test('bot plays a matching card when one is available', () => {
  const g = botGame({
    hand: [card('b1', 'red', '5'), card('b2', 'blue', '3')],
    top: card('top', 'red', '7'),
  });
  const before = g.players[0].hand.length;
  botMove(g, 0);
  assert.equal(g.players[0].hand.length, before - 1, "a card left the bot's hand");
  assert.equal(g.top.id, 'b1', 'the color-matching card was played');
  assert.equal(g.turn, 1, 'turn moved to the other seat');
});

test('bot draws when blocked, then plays the drawn card', () => {
  const g = botGame({
    hand: [card('b1', 'blue', '1'), card('b2', 'green', '2')],
    top: card('top', 'red', '7'),
    deck: [card('drawn', 'red', '3')],
  });
  botMove(g, 0);
  assert.equal(g.top.id, 'drawn', 'the drawn (matching) card was played');
  assert.equal(g.turn, 1);
});

test('bot draws, finds nothing playable, and passes the turn', () => {
  const g = botGame({
    hand: [card('b1', 'blue', '1'), card('b2', 'green', '2')],
    top: card('top', 'red', '7'),
    deck: [card('drawn', 'blue', '5')],
  });
  botMove(g, 0);
  assert.equal(g.top.id, 'top', 'nothing was played — the top card is unchanged');
  assert.equal(g.players[0].hand.length, 3, 'the drawn card stays in hand');
  assert.equal(g.turn, 1, 'the turn was passed');
});

test('bot picks the color it holds most when playing a wild', () => {
  const g = botGame({
    hand: [
      card('w', 'wild', 'wild', 'wild'),
      card('b1', 'red', '1'),
      card('b2', 'red', '2'),
      card('b3', 'red', '3'),
      card('b4', 'blue', '4'),
    ],
    top: card('top', 'green', '5'),
  });
  botMove(g, 0);
  assert.equal(g.top.kind, 'wild', 'the wild was the card played');
  assert.equal(g.currentColor, 'red', 'it chose the color it holds most');
});

test('bot auto-calls UNO when a move leaves it with one card', () => {
  const g = botGame({
    hand: [card('b1', 'red', '5'), card('b2', 'red', '3')],
    top: card('top', 'red', '7'),
  });
  botMove(g, 0);
  assert.equal(g.players[0].hand.length, 1);
  assert.equal(g.players[0].unoCalled, true, 'UNO was called');
});

test("botMove does not throw when it is not the bot's turn", () => {
  const g = botGame({
    hand: [card('b1', 'blue', '1')],
    top: card('top', 'red', '7'),
    deck: [card('d1', 'green', '9')],
  });
  g.turn = 1; // not the bot's turn: playCard must reject, and the call must not throw
  assert.doesNotThrow(() => botMove(g, 0));
});
