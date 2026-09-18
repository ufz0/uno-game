import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import io from 'socket.io-client';

process.env.PORT = '0';
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

test('the game waits until every human is ready', { timeout: 30000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  assert.equal(created.ok, true);
  await emitAck(b, 'join', { name: 'Bob', code: created.code });

  const early = await emitAck(a, 'start');
  assert.equal(early.ok, false);
  assert.match(early.error, /ready/);

  await emitAck(a, 'ready', { on: true });
  const partial = await emitAck(a, 'start');
  assert.equal(partial.ok, false);
  assert.match(partial.error, /Bob/);

  await emitAck(b, 'ready', { on: true });
  const started = await emitAck(a, 'start');
  assert.equal(started.ok, true);

  const st = await awaitState(a, (x) => x.status === 'playing', 5000);
  assert.equal(st.players.length, 2);
  assert.ok(st.players.every((p) => p.ready));

  a.close();
  b.close();
});

test('the party leader can kick a player from the lobby', { timeout: 30000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  await emitAck(b, 'join', { name: 'Bob', code: created.code });

  const kicked = new Promise((r) => b.on('kicked', r));
  const res = await emitAck(a, 'kick', { index: 1 });
  assert.equal(res.ok, true);
  assert.equal((await kicked).reason, 'host');

  const st = await latest(a);
  assert.equal(st.players.length, 1);
  assert.equal(st.players[0].name, 'Alice');

  const c = await connect();
  await emitAck(c, 'join', { name: 'Carol', code: created.code });
  const denied = await emitAck(c, 'kick', { index: 0 });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /party leader/);

  a.close();
  b.close();
  c.close();
});

test('creating a new table while seated leaves the old one', { timeout: 30000 }, async () => {
  const a = await connect();
  const first = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  assert.equal(first.ok, true);
  await new Promise((r) => setTimeout(r, 20));
  const before = rooms.size;

  const second = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  assert.equal(second.ok, true);
  assert.notEqual(second.code, first.code);

  // the old room had one human, so the move tore it down — no leak
  assert.equal(rooms.size, before);
  const st = await latest(a);
  assert.equal(st.code, second.code);

  a.close();
});

test('joining while already seated at a table is refused', { timeout: 30000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  await emitAck(b, 'join', { name: 'Bob', code: created.code });

  const second = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  assert.equal(second.ok, true);

  const again = await emitAck(b, 'join', { name: 'Bob', code: second.code });
  assert.equal(again.ok, false);
  assert.match(again.error, /already at a table/);

  // b is still seated at the first table
  const stB = await latest(b);
  assert.equal(stB.code, created.code);

  a.close();
  b.close();
});

test('two humans play a complete game to a winner', { timeout: 90000 }, async () => {
  const a = await connect();
  const b = await connect();

  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z2-9]{6}$/);

  const joined = await emitAck(b, 'join', { name: 'Bob', code: created.code });
  assert.equal(joined.ok, true);

  await emitAck(a, 'ready', { on: true });
  await emitAck(b, 'ready', { on: true });
  const started = await emitAck(a, 'start');
  assert.equal(started.ok, true);

  const st = await playToTheEnd(a, b);
  assert.ok(st.winner === 0 || st.winner === 1);

  a.close();
  b.close();
});

test('rematch: when everyone votes in, the next round deals immediately', { timeout: 90000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  await emitAck(b, 'join', { name: 'Bob', code: created.code });
  await emitAck(a, 'ready', { on: true });
  await emitAck(b, 'ready', { on: true });
  await emitAck(a, 'start');

  const st = await playToTheEnd(a, b);
  assert.equal(st.status, 'over');
  assert.ok(st.rematch && !st.rematch.locked);

  const reshufA = new Promise((r) => a.on('reshuffle', r));
  const reshufB = new Promise((r) => b.on('reshuffle', r));
  const t0 = Date.now();
  await emitAck(a, 'rematch', { again: true });
  await emitAck(b, 'rematch', { again: true });
  assert.ok((await reshufA).count >= 1);
  await reshufB;

  const st2 = await awaitState(a, (x) => x.status === 'playing', 3500);
  assert.ok(Date.now() - t0 < 3500, 'the remaining rematch timer should be skipped');
  assert.equal(st2.players.length, 2);
  assert.equal(st2.yourHand.length, 7);

  // play the second round out so the table can be torn down cleanly
  await playToTheEnd(a, b);

  a.close();
  b.close();
});

test('rematch: players who do not vote in time are kicked', { timeout: 60000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  await emitAck(b, 'join', { name: 'Bob', code: created.code });
  await emitAck(a, 'ready', { on: true });
  await emitAck(b, 'ready', { on: true });
  await emitAck(a, 'start');

  const st = await playToTheEnd(a, b);
  assert.equal(st.status, 'over');

  const guard = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
  const ka = await Promise.race([new Promise((r) => a.on('kicked', r)), guard(9000)]);
  const kb = await Promise.race([new Promise((r) => b.on('kicked', r)), guard(9000)]);
  assert.equal(ka.reason, 'timeout');
  assert.equal(kb.reason, 'timeout');

  a.close();
  b.close();
});

test('tables with bots deal straight away; a human plus three bots plays to a winner', { timeout: 120000 }, async () => {
  const a = await connect();
  const b = await connect();

  const created = await emitAck(a, 'create', { name: 'Host', bots: 3 });
  assert.equal(created.ok, true);

  // no lobby for bot tables: the first deal lands right after create
  const stPlaying = await awaitState(a, (x) => x.status === 'playing', 5000);
  assert.equal(stPlaying.players.length, 4);

  // the game is already running, so late joiners are refused
  const joined = await emitAck(b, 'join', { name: 'Late', code: created.code });
  assert.equal(joined.ok, false);
  assert.match(joined.error, /already started/);

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

test('a solo table with one bot plays to a winner and rematches alone', { timeout: 180000 }, async () => {
  const a = await connect();

  const created = await emitAck(a, 'create', { name: 'Solo', bots: 1 });
  assert.equal(created.ok, true);

  // straight to the table, no ready-up
  const st = await awaitState(a, (x) => x.status === 'playing', 5000);
  assert.equal(st.players.length, 2);
  assert.ok(st.players.some((p) => p.isBot));

  for (let i = 0; i < 400; i++) {
    const cur = await awaitState(a, (x) => x.status === 'over' || x.canAct, 30000);
    if (cur.status === 'over') break;
    await act(a);
  }

  const over = await awaitState(a, (x) => x.status === 'over', 120000);
  assert.ok(over.winner !== null);
  assert.ok(over.rematch && !over.rematch.locked);

  // one human voting is enough to run it back
  const reshuf = new Promise((r) => a.on('reshuffle', r));
  await emitAck(a, 'rematch', { again: true });
  assert.ok((await reshuf).count >= 1);

  const next = await awaitState(a, (x) => x.status === 'playing', 5000);
  assert.equal(next.players.length, 2);
  assert.equal(next.yourHand.length, 7);

  a.close();
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
