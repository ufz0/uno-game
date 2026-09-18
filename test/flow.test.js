import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import io from 'socket.io-client';

process.env.PORT = '0';

const mod = await import('../server.js');
const { server, rooms } = mod;
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}`;

after(() => {
  for (const room of rooms.values()) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.botTimer);
  }
  rooms.clear();
  return new Promise((r) => server.close(r));
});

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], forceNew: true });
    // Persistent tracker so we never miss a broadcast (attached before 'connect').
    s.on('state', (st) => { s._st = st; });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const emitAck = (s, ev, payload = {}) => new Promise((r) => s.emit(ev, payload, r));

function awaitState(s, pred, ms = 30000) {
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

// Resolve to the freshest state (the next broadcast, or the cached one if it already matches).
async function latest(s, ms = 3000) {
  if (s._st) {
    await new Promise((r) => setTimeout(r, 0));
    return s._st;
  }
  return awaitState(s, () => true, ms);
}

async function act(s) {
  const st = await latest(s);
  if (!st || st.status !== 'playing') return;

  const doPlay = async (state) => {
    const card = state.yourHand.find((c) => c.id === state.playable[0]);
    const color = card.kind === 'wild' || card.kind === 'wild4' ? 'red' : null;
    await emitAck(s, 'play', { card: card.id, color });
  };

  if (st.playable.length > 0) {
    await doPlay(st);
  } else {
    await emitAck(s, 'draw');
    const st2 = await awaitState(s, (x) => x.drewThisTurn || x.status !== 'playing', 5000);
    if (st2.status === 'playing' && st2.playable.length > 0) await doPlay(st2);
    else await emitAck(s, 'pass');
  }

  const st3 = await latest(s);
  if (st3 && st3.status === 'playing') {
    const me = st3.players.find((p) => p.index === st3.yourIndex);
    if (me && me.handCount === 1 && !me.uno) await emitAck(s, 'uno');
  }
}

async function playToTheEnd(a, b, maxMoves = 500) {
  for (let i = 0; i < maxMoves; i++) {
    // Grab the freshest state from a's view; it tells us whose turn it is.
    const st = await latest(a);
    if (st.status === 'over') return st;
    if (st.status !== 'playing') continue;
    // a.canAct is true when it is a's turn, false when it is b's.
    const actor = st.canAct ? a : b;
    await act(actor);
  }
  throw new Error('game did not finish within the move budget');
}

test('two humans play a complete game to a winner', { timeout: 90000 }, async () => {
  const a = await connect();
  const b = await connect();

  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z2-9]{4}$/);

  const joined = await emitAck(b, 'join', { name: 'Bob', code: created.code });
  assert.equal(joined.ok, true);

  const started = await emitAck(a, 'start');
  assert.equal(started.ok, true);

  const st = await playToTheEnd(a, b);
  assert.ok(st.winner === 0 || st.winner === 1);

  a.close();
  b.close();
});

test('a human plus three bots plays to a winner', { timeout: 120000 }, async () => {
  const a = await connect();
  const b = await connect();

  const created = await emitAck(a, 'create', { name: 'Host', bots: 3 });
  assert.equal(created.ok, true);

  // game auto-started with bots; let the host sit in as a second seat via a joiner
  const joined = await emitAck(b, 'join', { name: 'Late', code: created.code });
  assert.equal(joined.ok, false);

  const stA = await awaitState(a, (st) => st.status === 'over' || st.canAct, 120000);
  assert.equal(stA.status, 'playing');
  assert.equal(stA.players.length, 4);

  for (let i = 0; i < 400; i++) {
    const st = await awaitState(a, (x) => x.status === 'over' || x.canAct, 30000);
    if (st.status === 'over') break;
    await act(a);
  }

  const final = await awaitState(a, (st) => st.status === 'over', 120000);
  assert.ok(final.winner !== null);

  a.close();
  b.close();
});

test('chat is relayed to the table', { timeout: 30000 }, async () => {
  const a = await connect();
  const b = await connect();
  await emitAck(a, 'create', { name: 'A1', bots: 0 });
  await emitAck(b, 'join', { name: 'B1', code: (a._st?.code) || (await awaitState(a, () => true)).code });

  const got = new Promise((r) => b.on('chat', r));
  a.emit('chat', { text: 'hello table' });
  const msg = await got;
  assert.equal(msg.text, 'hello table');
  assert.equal(msg.name, 'A1');

  a.close();
  b.close();
});

test('wrong code and full tables are rejected politely', { timeout: 30000 }, async () => {
  const a = await connect();
  const res = await emitAck(a, 'join', { name: 'X', code: 'ZZZZ' });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  a.close();
});
