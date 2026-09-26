import { buildDeck, shuffle, isWild } from './cards.js';

export const COLORS = ['red', 'yellow', 'green', 'blue'];

let playerSeq = 0;

export class Game {
  constructor() {
    this.status = 'lobby';
    this.players = [];
    this.deck = [];
    this.discard = [];
    this.turn = 0;
    this.direction = 1;
    this.currentColor = null;
    this.winner = null;
    this.drewThisTurn = false;
  }

  addPlayer(name, isBot = false, id = null) {
    const p = {
      id: id ?? `p${playerSeq++}`,
      name,
      isBot,
      hand: [],
      unoCalled: false,
      disconnected: false,
    };
    this.players.push(p);
    return this.players.length - 1;
  }

  playerIndexById(id) {
    return this.players.findIndex((p) => p.id === id);
  }

  removePlayer(index) {
    this.players.splice(index, 1);
  }

  get top() {
    return this.discard[this.discard.length - 1] || null;
  }

  canStart() {
    return this.players.length >= 2 && this.players.length <= 4;
  }

  start() {
    if (!this.canStart()) throw new Error('Need 2-4 players to start');
    this.status = 'playing';
    this.deck = buildDeck();
    this.discard = [];
    this.players.forEach((p) => {
      p.hand = this.drawCards(7);
      p.unoCalled = false;
    });
    this.winner = null;
    this.direction = Math.random() < 0.5 ? 1 : -1;
    this.turn = Math.floor(Math.random() * this.players.length);
    let first = this.deck.pop();
    while (isWild(first)) {
      this.deck.push(first);
      shuffle(this.deck);
      first = this.deck.pop();
    }
    this.discard.push(first);
    this.currentColor = first.color;
    this.drewThisTurn = false;
  }

  reset() {
    this.status = 'lobby';
    this.deck = [];
    this.discard = [];
    this.winner = null;
    this.currentColor = null;
    this.drewThisTurn = false;
    this.players.forEach((p) => {
      p.hand = [];
      p.unoCalled = false;
      p.disconnected = false;
    });
  }

  drawCards(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) this.reshuffle();
      const c = this.deck.pop();
      // A reshuffle of a one-card discard leaves the deck empty: all 107
      // other cards are in hands and there is genuinely nothing to draw.
      // Skip the phantom card instead of pushing undefined.
      if (c) out.push(c);
    }
    return out;
  }

  reshuffle() {
    if (this.discard.length === 0) return;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard);
    this.discard = [top];
  }

  nextIndex(offset = 1) {
    const n = this.players.length;
    return (((this.turn + this.direction * offset) % n) + n) % n;
  }

  advance(steps = 1) {
    const n = this.players.length;
    this.turn = (((this.turn + this.direction * steps) % n) + n) % n;
  }

  isPlayable(cardObj, hand = []) {
    if (cardObj.kind === 'wild') return true;
    if (cardObj.kind === 'wild4') {
      return !hand.some((c) => c.color === this.currentColor);
    }
    if (cardObj.color === this.currentColor) return true;
    const top = this.top;
    return top !== null && cardObj.value === top.value;
  }

  playableCards(hand) {
    return hand.filter((c) => this.isPlayable(c, hand));
  }

  playCard(playerIndex, cardId, chosenColor = null) {
    if (this.status !== 'playing') return { ok: false, error: 'Game is not in progress' };
    if (playerIndex !== this.turn) return { ok: false, error: 'Not your turn' };
    const p = this.players[playerIndex];
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return { ok: false, error: 'Card not in hand' };
    const card = p.hand[idx];
    if (!this.isPlayable(card, p.hand)) return { ok: false, error: 'That card does not match' };

    if (isWild(card)) {
      if (!COLORS.includes(chosenColor))
        return { ok: false, error: 'Pick a color for the wild card' };
      this.currentColor = chosenColor;
    } else {
      this.currentColor = card.color;
    }

    p.hand.splice(idx, 1);
    this.discard.push(card);
    this.drewThisTurn = false;

    let affected = null;
    let penalty = null;
    if (card.kind === 'skip') {
      this.advance(2);
    } else if (card.kind === 'reverse') {
      this.direction *= -1;
      // Two players: acts as a skip, so the turn comes back to the player who played.
      // Three or more: play continues against the new direction, to the next seat.
      this.advance(this.players.length === 2 ? 2 : 1);
    } else if (card.kind === 'draw2') {
      affected = this.nextIndex(1);
      this.players[affected].hand.push(...this.drawCards(2));
      penalty = 2;
      this.advance(2);
    } else if (card.kind === 'wild4') {
      affected = this.nextIndex(1);
      this.players[affected].hand.push(...this.drawCards(4));
      penalty = 4;
      this.advance(2);
    } else {
      this.advance(1);
    }

    if (p.hand.length === 0) {
      if (!p.unoCalled) {
        p.hand.push(...this.drawCards(2));
        p.unoCalled = false;
        return { ok: true, card, affected, penalty, unoPenalty: true };
      }
      this.status = 'over';
      this.winner = playerIndex;
      return { ok: true, card, affected, penalty };
    }

    if (p.hand.length === 1) p.unoCalled = false;
    return { ok: true, card, affected, penalty };
  }

  draw(playerIndex) {
    if (this.status !== 'playing') return { ok: false, error: 'Game is not in progress' };
    if (playerIndex !== this.turn) return { ok: false, error: 'Not your turn' };
    if (this.drewThisTurn) return { ok: false, error: 'Already drew this turn' };
    const [c] = this.drawCards(1);
    if (c) this.players[playerIndex].hand.push(c);
    this.drewThisTurn = true;
    return { ok: true, card: c };
  }

  pass(playerIndex) {
    if (this.status !== 'playing') return { ok: false, error: 'Game is not in progress' };
    if (playerIndex !== this.turn) return { ok: false, error: 'Not your turn' };
    if (!this.drewThisTurn) return { ok: false, error: 'Draw a card first' };
    this.drewThisTurn = false;
    this.advance(1);
    return { ok: true };
  }

  callUno(playerIndex) {
    if (this.status !== 'playing') return { ok: false, error: 'Game is not in progress' };
    const p = this.players[playerIndex];
    if (!p) return { ok: false, error: 'No such player' };
    if (p.hand.length !== 1)
      return { ok: false, error: 'You need exactly one card left to shout UNO' };
    p.unoCalled = true;
    return { ok: true };
  }
}
