import './_env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import io from 'socket.io-client';
import { Game } from '../lib/game.js';

process.env.PORT = '0';
process.env.TURN_MS = '300'; // short turn window so timers can be observed
process.env.REMATCH_MS = '4000';

const mod = await import('../server.js');
const { server, rooms, flushPersist, reloadRooms } = mod;
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}`;

function clearRoomTimers(room) {
  clearTimeout(room.turnTimer);
  clearTimeout(room.botTimer);
  if (room.rematch) {
    for (const t of room.rematch.timers.values()) clearTimeout(t);
    if (room.rematch.startTimer) clearTimeout(room.rematch.startTimer);
  }
}

after(() => {
  for (const room of rooms.values()) clearRoomTimers(room);
  rooms.clear();
  flushPersist();
  return new Promise((r) => server.close(r));
});

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(url, { transports: ['websocket'], forceNew: true });
    s.on('state', (st) => {
      s._st = st;
    });
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

// Drop every room except `code` (and its timers) so each restart simulation
// reloads exactly the room under test — leftovers from earlier tests would
// otherwise ride along on disk and muddy the counts.
function only(code) {
  for (const c of [...rooms.keys()]) {
    if (c !== code) {
      clearRoomTimers(rooms.get(c));
      rooms.delete(c);
    }
  }
}

// A bare mid-game room, shaped like newRoom() produces, so the restart can be
// simulated in-process: flush to disk, clear the map, reload from disk.
function fakeRoom(code, { players, status, winner = null, rematch = null }) {
  const game = new Game();
  for (const [name, isBot, id] of players) game.addPlayer(name, isBot, id);
  if (status !== 'lobby') game.start();
  game.status = status;
  game.winner = winner;
  return {
    code,
    game,
    host: players[0][2],
    humans: new Set(players.filter(([, isBot]) => !isBot).map(([, , id]) => id)),
    chat: [],
    turnTimer: null,
    botTimer: null,
    turnDeadline: 0,
    rematch,
  };
}

test('a mid-game table survives a server restart', { timeout: 30000 }, async () => {
  const a = await connect();
  const b = await connect();
  const created = await emitAck(a, 'create', { name: 'Alice', bots: 0 });
  await emitAck(b, 'join', { code: created.code, name: 'Bob' });
  await emitAck(a, 'ready', { on: true });
  await emitAck(b, 'ready', { on: true });
  await emitAck(a, 'start');
  await awaitState(a, (x) => x.status === 'playing');
  await awaitState(b, (x) => x.status === 'playing');

  const room = rooms.get(created.code);
  a.emit('chat', { text: 'see you on the other side' });
  for (let i = 0; i < 100 && !room.chat.some((m) => m.text === 'see you on the other side'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Freeze time, snapshot the ground truth, then "restart" the server.
  clearRoomTimers(room);
  const before = {
    status: room.game.status,
    turn: room.game.turn,
    direction: room.game.direction,
    top: room.game.top.id,
    deck: room.game.deck.length,
    hands: room.game.players.map((p) => p.hand.length),
    names: room.game.players.map((p) => p.name),
    host: room.host,
    humans: [...room.humans].sort(),
  };
  flushPersist();
  rooms.clear();
  const n = reloadRooms();

  assert.equal(n, 1, 'the table came back from disk');
  const r2 = rooms.get(created.code);
  assert.ok(r2, 'the table is back in the rooms map');
  assert.equal(r2.game.status, before.status);
  assert.equal(r2.game.turn, before.turn);
  assert.equal(r2.game.direction, before.direction);
  assert.equal(r2.game.top.id, before.top, 'the discard pile is intact');
  assert.equal(r2.game.deck.length, before.deck, 'the draw pile is intact');
  assert.deepEqual(
    r2.game.players.map((p) => p.hand.length),
    before.hands,
    'hands are intact',
  );
  assert.deepEqual(
    r2.game.players.map((p) => p.name),
    before.names,
  );
  assert.equal(r2.host, before.host, 'the host pointer survived');
  assert.deepEqual([...r2.humans].sort(), before.humans);
  assert.ok(
    r2.chat.some((m) => m.text === 'see you on the other side'),
    'chat history survived',
  );
  assert.ok(r2.turnTimer, 'the live turn timer was re-armed for the human turn');

  a.close();
  b.close();
});

test(
  'a turn that ran out while the server was down is auto-passed on restore',
  { timeout: 30000 },
  async () => {
    only('ZZZZT2');
    const room = fakeRoom('ZZZZT2', {
      players: [
        ['Alice', false, 'ghostA'],
        ['Bob', false, 'ghostB'],
      ],
      status: 'playing',
    });
    room.turnDeadline = Date.now() - 1000; // the window lapsed while we were down
    const beforeTurn = room.game.turn;
    rooms.set(room.code, room);
    flushPersist();
    rooms.clear();
    reloadRooms();

    const r2 = rooms.get('ZZZZT2');
    assert.equal(r2.game.status, 'playing');
    assert.equal(r2.game.turn, (beforeTurn + 1) % 2, 'the expired turn was passed on');
    assert.ok(r2.turnDeadline > Date.now(), 'a fresh turn window is running');
    assert.ok(r2.turnTimer, 'the turn timer was re-armed');
  },
);

test(
  'a lapsed rematch timeout kicks its player and the next round starts',
  { timeout: 30000 },
  async () => {
    only('ZZZZT3');
    const now = Date.now();
    const room = fakeRoom('ZZZZT3', {
      players: [
        ['Alice', false, 'ghostA'],
        ['Bob', false, 'ghostB'],
        ['Ruby', true, null],
      ],
      status: 'over',
      winner: 0,
      rematch: {
        votes: new Set(['ghostB']), // Bob already said "again"
        deadlines: new Map([['ghostA', now - 500]]), // Alice's window lapsed
        timers: new Map(),
        startTimer: null,
        startAt: null,
        locked: false,
      },
    });
    rooms.set(room.code, room);
    flushPersist();
    rooms.clear();
    reloadRooms();

    const r2 = rooms.get('ZZZZT3');
    // Alice is out (timed out while we were down), Bob's vote is the last one,
    // so the rematch locks and the next round is scheduled.
    assert.equal(r2.game.status, 'over', 'the game stays over until the reshuffle window elapses');
    assert.equal(r2.rematch.locked, true, 'the remaining vote locked the rematch');

    const until = Date.now() + 8000;
    while (
      rooms.get('ZZZZT3') &&
      rooms.get('ZZZZT3').game.status !== 'playing' &&
      Date.now() < until
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const r3 = rooms.get('ZZZZT3');
    assert.equal(r3.game.status, 'playing', 'the next round started after the reshuffle window');
    assert.deepEqual(
      r3.game.players.map((p) => p.hand.length),
      [7, 7],
      'both seats were dealt',
    );
    assert.ok(
      r3.game.players.some((p) => p.isBot),
      'the bot seat survived the restart',
    );
    assert.equal(
      r3.game.players.find((p) => p.name === 'Alice'),
      undefined,
      'the timed-out seat is gone',
    );
  },
);

test(
  'pending rematch timeouts keep running and can tear the table down',
  { timeout: 30000 },
  async () => {
    only('ZZZZT4');
    const now = Date.now();
    const room = fakeRoom('ZZZZT4', {
      players: [
        ['Alice', false, 'ghostA'],
        ['Bob', false, 'ghostB'],
        ['Ruby', true, null],
      ],
      status: 'over',
      winner: 1,
      rematch: {
        votes: new Set(),
        deadlines: new Map([
          ['ghostA', now + 400],
          ['ghostB', now + 400],
        ]),
        timers: new Map(),
        startTimer: null,
        startAt: null,
        locked: false,
      },
    });
    rooms.set(room.code, room);
    flushPersist();
    rooms.clear();
    const n = reloadRooms();
    assert.equal(n, 1);
    const r2 = rooms.get('ZZZZT4');
    assert.equal(r2.rematch.locked, false);
    assert.equal(r2.rematch.timers.size, 2, 'both pending timeouts were re-armed');

    // Both fire shortly after: with no humans left, the table is destroyed.
    const until = Date.now() + 4000;
    while (rooms.has('ZZZZT4') && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(rooms.has('ZZZZT4'), false, 'once every human times out, the table is torn down');
  },
);

test(
  'a returned player re-claims their seat and the host pointer follows',
  { timeout: 30000 },
  async () => {
    only('ZZZZR1');
    const room = fakeRoom('ZZZZR1', {
      players: [
        ['Alice', false, 'ghostA'],
        ['Bob', false, 'ghostB'],
      ],
      status: 'playing',
    });
    room.host = 'ghostA'; // Alice was the host before the restart
    rooms.set(room.code, room);
    flushPersist();
    rooms.clear();
    const n = reloadRooms();
    assert.equal(n, 1);

    const r2 = rooms.get('ZZZZR1');
    // After a restart every human seat is dropped (their socket is dead), so
    // the seat can be handed back through rejoin.
    assert.equal(
      r2.game.players.every((p) => !p.isBot && p.disconnected),
      true,
    );

    // Alice reconnects as a fresh socket and takes the seat (and the host role) back.
    const a = await connect();
    const res = await emitAck(a, 'rejoin', { code: 'ZZZZR1', name: 'Alice' });
    assert.equal(res.ok, true, 'rejoin accepted the returned seat');
    const r3 = rooms.get('ZZZZR1');
    const me = r3.game.players.find((p) => p.name === 'Alice');
    assert.equal(me.id, a.id, 'the seat now points at the fresh socket');
    assert.equal(me.disconnected, false);
    assert.equal(r3.host, a.id, 'the host pointer followed the seat to the fresh socket');
    assert.equal(r3.humans.has('ghostA'), false, 'the ghost id no longer keeps the room alive');
    assert.equal(r3.humans.has(a.id), true);

    a.close();
  },
);

test(
  'a restored lobby drops dead human seats, keeps bots, and the joiner takes host',
  { timeout: 30000 },
  async () => {
    only('ZZZZL1');
    const room = fakeRoom('ZZZZL1', {
      players: [
        ['Alice', false, 'ghostA'],
        ['Ruby', true, null],
      ],
      status: 'lobby',
    });
    room.host = 'ghostA';
    rooms.set(room.code, room);
    flushPersist();
    rooms.clear();
    const n = reloadRooms();
    assert.equal(n, 1);

    const r2 = rooms.get('ZZZZL1');
    // In the lobby a dead human is just a ghost seat: drop them, keep the bot,
    // and clear the dead host so the next sitter can lead.
    assert.equal(r2.game.players.filter((p) => !p.isBot).length, 0, 'the dead human seat is gone');
    assert.equal(
      r2.game.players.some((p) => p.isBot),
      true,
      'the bot seat is kept',
    );
    assert.equal(r2.host, null, 'the dead host pointer is cleared');
    assert.equal(r2.humans.size, 0);

    // A friend joins the surviving table and takes over the host controls.
    const f = await connect();
    const res = await emitAck(f, 'join', { code: 'ZZZZL1', name: 'Carol' });
    assert.equal(res.ok, true);
    const r3 = rooms.get('ZZZZL1');
    assert.equal(r3.host, f.id, 'the joiner inherits the dead host seat');
    assert.equal(r3.game.players.length, 2, 'the table is the bot plus the new sitter');

    f.close();
  },
);

test(
  'rejoin on the rematch screen moves the seat, vote, and deadline onto the fresh socket',
  { timeout: 30000 },
  async () => {
    only('ZZZZM1');
    const now = Date.now();
    const room = fakeRoom('ZZZZM1', {
      players: [
        ['Alice', false, 'ghostA'],
        ['Bob', false, 'ghostB'],
      ],
      status: 'over',
      winner: 0,
      rematch: {
        votes: new Set(),
        deadlines: new Map([
          ['ghostA', now + 60000],
          ['ghostB', now + 60000],
        ]),
        timers: new Map(),
        startTimer: null,
        startAt: null,
        locked: false,
      },
    });
    room.host = 'ghostA';
    rooms.set(room.code, room);
    flushPersist();
    rooms.clear();
    const n = reloadRooms();
    assert.equal(n, 1);

    const a = await connect();
    const res = await emitAck(a, 'rejoin', { code: 'ZZZZM1', name: 'Alice' });
    assert.equal(res.ok, true, 'rejoin is accepted on the rematch screen');
    const r2 = rooms.get('ZZZZM1');
    const me = r2.game.players.find((p) => p.name === 'Alice');
    assert.equal(me.id, a.id, 'the seat moved to the fresh socket');
    assert.equal(r2.host, a.id, 'the host pointer followed the seat');
    assert.equal(r2.rematch.deadlines.has('ghostA'), false, 'the ghost deadline is gone');
    assert.ok(
      r2.rematch.deadlines.has(a.id) && r2.rematch.deadlines.get(a.id) > now,
      'Alice\u2019s rematch window survived the restart and is still on the clock',
    );
    assert.ok(r2.rematch.timers.has(a.id), 'the timeout was re-armed under the fresh id');

    // Bob never voted and his window is long; Alice now votes, which should
    // lock the rematch with both seats accounted for.
    const b = await connect();
    await emitAck(b, 'rejoin', { code: 'ZZZZM1', name: 'Bob' });
    await emitAck(a, 'rematch', { again: true });
    await emitAck(b, 'rematch', { again: true });
    const r3 = rooms.get('ZZZZM1');
    assert.equal(r3.rematch.locked, true, 'both votes landed and the rematch locked');
    assert.equal(r3.rematch.votes.size, 2);

    a.close();
    b.close();
  },
);
