import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import io from 'socket.io-client';

process.env.PORT = '0';
process.env.REMATCH_MS = '4000';
process.env.MAX_ROOMS = '3';

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
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const emitAck = (s, ev, payload = {}) => new Promise((r) => s.emit(ev, payload, r));

test('creating rooms beyond the cap is refused', { timeout: 30000 }, async () => {
  const socks = [];
  for (let i = 0; i < 3; i++) {
    const s = await connect();
    const res = await emitAck(s, 'create', { name: `H${i}`, bots: 0 });
    assert.equal(res.ok, true);
    socks.push(s);
  }

  const late = await connect();
  const res = await emitAck(late, 'create', { name: 'Full', bots: 0 });
  assert.equal(res.ok, false);
  assert.match(res.error, /full/);
  assert.equal(rooms.size, 3);

  for (const s of socks) s.close();
  late.close();
});
