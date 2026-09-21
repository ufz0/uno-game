import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import io from 'socket.io-client';

process.env.PORT = '0';
process.env.TURN_MS = '800'; // a short turn window so the timer can be observed
process.env.REMATCH_MS = '4000';

const mod = await import('../server.js');
const { server, rooms } = mod;
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}`;

after(() => {
  for (const room of rooms.values()) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.botTimer);
    if (room.rematch) {
      for (const t of room.rematch.timers.values()) clearTimeout(t);
      if (room.rematch.startTimer) clearTimeout(room.rematch.startTimer);
    }
  }
  rooms.clear();
  return new Promise((r) => server.close(r));
});

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], forceNew: true });
    s.on('state', (st) => { s._st = st; });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const emitAck = (s, ev, payload = {}) => new Promise((r) => s.emit(ev, payload, r));

function awaitState(s, pred, ms = 6000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for state')), ms);
    const h = (st) => {
      s._st = st;
      if (pred(st)) {
        clearTimeout(t);
        s.off('state', h);
        resolve(st);
      }
    };
    if (s._st && pred(s._st)) {
      clearTimeout(t);
      resolve(s._st);
      return;
    }
    s.on('state', h);
  });
}

test('a player who stalls is auto-passed when their turn runs out', { timeout: 30000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  await emitAck(b, 'join', { name: 'Bob', code: created.code });
  await emitAck(a, 'ready', { on: true });
  await emitAck(b, 'ready', { on: true });
  await emitAck(a, 'start');

  const toasts = [];
  a.on('toast', (t) => toasts.push(t.text));
  b.on('toast', (t) => toasts.push(t.text));

  const stA = await awaitState(a, (x) => x.status === 'playing', 5000);
  const other = stA.canAct ? b : a; // whichever socket does NOT hold the turn

  // Nobody acts: the actor's turn window expires and the turn is passed on.
  const st = await awaitState(other, (x) => x.canAct, 5000);
  assert.equal(st.canAct, true, 'the stalled turn was passed to the other player');
  assert.ok(toasts.some((t) => /took too long/.test(t)), 'an auto-pass toast was relayed');

  a.close();
  b.close();
});
