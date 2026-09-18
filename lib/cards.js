const COLORS = ['red', 'yellow', 'green', 'blue'];

let seq = 0;
const card = (color, value, kind) => ({ id: `c${seq++}`, color, value, kind });

export function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push(card(color, '0', 'number'));
    for (let n = 1; n <= 9; n++) {
      deck.push(card(color, String(n), 'number'));
      deck.push(card(color, String(n), 'number'));
    }
    for (let i = 0; i < 2; i++) {
      deck.push(card(color, 'skip', 'skip'));
      deck.push(card(color, 'reverse', 'reverse'));
      deck.push(card(color, 'draw2', 'draw2'));
    }
  }
  for (let i = 0; i < 4; i++) deck.push(card('wild', 'wild', 'wild'));
  for (let i = 0; i < 4; i++) deck.push(card('wild', 'wild4', 'wild4'));
  return shuffle(deck);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function isWild(cardObj) {
  return cardObj.kind === 'wild' || cardObj.kind === 'wild4';
}
