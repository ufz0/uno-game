import { COLORS } from './game.js';

function countColors(hand) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (counts[c.color] != null) counts[c.color]++;
  return counts;
}

function pickColorFor(game, playerIndex) {
  const counts = countColors(game.players[playerIndex].hand);
  return COLORS.map((c) => [c, counts[c]]).sort((a, b) => b[1] - a[1])[0][0];
}

function scoreCard(game, card, playerIndex) {
  const others = game.players.map((p, i) => (i === playerIndex ? null : p)).filter(Boolean);
  const minOpp = Math.min(...others.map((p) => p.hand.length), Infinity);
  let s = 0;
  if (card.color === game.currentColor) s += 3;
  switch (card.kind) {
    case 'draw2':
      s += minOpp <= 3 ? 9 : 5;
      break;
    case 'skip':
      s += minOpp <= 2 ? 7 : 4;
      break;
    case 'reverse':
      s += game.players.length === 2 ? 7 : 3;
      break;
    case 'wild':
      s -= 1;
      break;
    case 'wild4':
      s -= 2;
      break;
    case 'number':
      s += 1;
      break;
  }
  return s + Math.random() * 0.5;
}

function pickBest(game, playable, playerIndex) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of playable) {
    const s = scoreCard(game, c, playerIndex);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

export function botMove(game, playerIndex) {
  const p = game.players[playerIndex];
  const colorFor = (c) =>
    c.kind === 'wild' || c.kind === 'wild4' ? pickColorFor(game, playerIndex) : null;

  let playable = game.playableCards(p.hand);
  if (playable.length === 0) {
    game.draw(playerIndex);
    playable = game.playableCards(p.hand);
    if (playable.length === 0) {
      game.pass(playerIndex);
      return;
    }
  }
  const best = pickBest(game, playable, playerIndex);
  game.playCard(playerIndex, best.id, colorFor(best));
  if (p.hand.length === 1) p.unoCalled = true;
}
