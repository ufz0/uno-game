import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { Game } from './lib/game.js';
import { botMove } from './lib/bot.js';
import { loadRooms, saveRooms } from './lib/persist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const MAX_PLAYERS = 4;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 100;
const TURN_MS = Number(process.env.TURN_MS) || 30000;
const REMATCH_MS = Number(process.env.REMATCH_MS) || 30000;
const CHAT_MIN_MS = Number(process.env.CHAT_MIN_MS) || 400;
const RESHUFFLE_MS = 1800;
const BOT_DELAY_MS = [1000, 2200];
// Where tables are persisted across restarts. Override per deployment
// (e.g. a bind-mounted dir in Docker); tests point it at a tmp file.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const BOT_NAMES = ['Ruby', 'Milo', 'Vera', 'Otis', 'Nova', 'Juno'];

const rooms = new Map();

// Six chars from a 32-char alphabet (~1.07B codes) — long enough that
// probing for live tables by guessing is not practical.
function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name || '')
    .replace(/[<>&"'`/\\]/g, '')
    .trim()
    .slice(0, 16);
  return n || 'Player';
}

// Two seats with the same name make chat attribution ("you") and the lobby
// list ambiguous, so a duplicate gets a numbered suffix.
function uniqueName(room, name) {
  const taken = new Set(room.game.players.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const candidate = name.slice(0, 16 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function newRoom() {
  return {
    code: genCode(),
    game: new Game(),
    host: null,
    humans: new Set(),
    chat: [],
    turnTimer: null,
    botTimer: null,
    turnDeadline: 0,
  };
}

// Fast path: the room is pinned on the socket when the player sits down
// (create/join/rejoin) and unpinned on leave/kick. The scan below stays as
// a fallback so a stale pointer can never strand a seated player.
function roomOf(socket) {
  const r = socket.data?.room;
  if (r && rooms.has(r.code) && r.humans.has(socket.id)) return r;
  for (const room of rooms.values()) if (room.humans.has(socket.id)) return room;
  return null;
}

function playerIndexOf(room, socketId) {
  return room.game.playerIndexById(socketId);
}

function stateFor(room, socket) {
  const g = room.game;
  const myIndex = playerIndexOf(room, socket.id);
  const myTurn = g.status === 'playing' && myIndex >= 0 && g.turn === myIndex;
  const humans = g.players.filter((p) => !p.isBot);
  const rm = room.rematch;
  return {
    code: room.code,
    status: g.status,
    winner: g.winner,
    turn: g.turn,
    direction: g.direction,
    currentColor: g.currentColor,
    deckCount: g.deck.length,
    top: g.top,
    drewThisTurn: myTurn ? g.drewThisTurn : false,
    yourIndex: myIndex,
    isHost: room.host === socket.id,
    canAct: myTurn,
    playable: myTurn ? g.playableCards(g.players[myIndex].hand).map((c) => c.id) : [],
    turnDeadline: g.status === 'playing' ? room.turnDeadline : null,
    turnTotal: TURN_MS,
    allReady: humans.length > 0 && humans.every((p) => p.ready),
    rematch: rm
      ? {
          locked: rm.locked,
          youVoted: rm.votes.has(socket.id),
          votes: g.players.map((p, i) => (rm.votes.has(p.id) ? i : -1)).filter((i) => i >= 0),
          deadline: rm.deadlines.get(socket.id) || null,
        }
      : null,
    players: g.players.map((p, i) => ({
      index: i,
      name: p.name,
      isBot: p.isBot,
      ready: p.isBot ? true : !!p.ready,
      handCount: p.hand.length,
      isCurrent: g.status === 'playing' && i === g.turn,
      uno: p.unoCalled,
      mustCallUno: p.hand.length === 1 && !p.unoCalled && g.status === 'playing',
      disconnected: p.disconnected,
    })),
    yourHand: myIndex >= 0 ? g.players[myIndex].hand.map((c) => ({ ...c })) : [],
    chat: room.chat.slice(-40),
  };
}

function broadcast(room) {
  for (const sid of room.humans) {
    const sock = io.sockets.sockets.get(sid);
    // A stale id must not throw here: an uncaught exception would take
    // down the whole process and every table with it.
    if (!sock) continue;
    io.to(sid).emit('state', stateFor(room, sock));
  }
  // Every state change funnels through broadcast (or destroyRoom), so this
  // one hook keeps the persisted copy current.
  persistRooms();
}

function toast(room, text) {
  for (const sid of room.humans) io.to(sid).emit('toast', { text });
}

function clearTimers(room) {
  clearTimeout(room.turnTimer);
  clearTimeout(room.botTimer);
  room.turnTimer = null;
  room.botTimer = null;
}

function clearRematch(room) {
  const rm = room.rematch;
  if (!rm) return;
  for (const t of rm.timers.values()) clearTimeout(t);
  if (rm.startTimer) clearTimeout(rm.startTimer);
  room.rematch = null;
}

function destroyRoom(room) {
  clearRematch(room);
  clearTimers(room);
  rooms.delete(room.code);
  persistRooms();
}

/* ---------- persistence ----------
 *
 * Tables live in memory; this mirrors them to DATA_FILE so a restart
 * (deploy, crash, laptop sleep) does not wipe mid-game tables. Writes are
 * debounced and atomic (tmp file + rename); live timers are rebuilt from
 * their deadlines on restore. Persistence is best-effort by design — a disk
 * failure must never take the table down with it.
 */
let persistTimer = null;

function persistRooms() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, 300);
  persistTimer.unref?.(); // a pending save must not hold the process open
}

function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    saveRooms(DATA_FILE, rooms);
  } catch (err) {
    console.error(`persist: write to ${DATA_FILE} failed: ${err.message}`);
  }
}

// Rebuild the live timers a restored room needs. Deadlines that already
// slipped past while the server was down fire immediately.
function rehydrateRoom(room) {
  const g = room.game;
  // Every socket from the previous life is dead. In the lobby a seat is only
  // useful while its human is there — drop the ghosts (keep the bots the
  // user added) and let the next joiner take the dead host pointer. Mid-game
  // (or on the rematch screen) the seat must survive, so it goes back to the
  // `disconnected` state that rejoin hands back.
  if (g.status === 'lobby') {
    for (let i = g.players.length - 1; i >= 0; i--) {
      if (!g.players[i].isBot) g.removePlayer(i);
    }
    room.humans.clear();
    room.host = null;
  } else {
    for (const p of g.players) {
      if (!p.isBot) p.disconnected = true;
    }
  }
  const now = Date.now();
  if (g.status === 'playing') {
    const cur = g.players[g.turn];
    if (cur?.isBot) {
      // The bot's random delay was not persisted; hand it a fresh one.
      const [min, max] = BOT_DELAY_MS;
      room.botTimer = setTimeout(() => runBot(room), min + Math.random() * (max - min));
    } else if (room.turnDeadline > now) {
      room.turnTimer = setTimeout(() => autoPass(room), room.turnDeadline - now);
    } else if (room.turnDeadline > 0) {
      autoPass(room);
    }
  } else if (room.rematch) {
    const rm = room.rematch;
    if (rm.locked && rm.startAt) {
      if (rm.startAt > now)
        rm.startTimer = setTimeout(() => startNextRound(room), rm.startAt - now);
      else startNextRound(room);
    } else if (!rm.locked) {
      for (const [sid, deadline] of [...rm.deadlines]) {
        if (deadline <= now) {
          rm.deadlines.delete(sid);
          kickPlayer(room, sid, 'timeout');
        } else {
          rm.timers.set(
            sid,
            setTimeout(() => kickPlayer(room, sid, 'timeout'), deadline - now),
          );
        }
      }
      // The last vote may have landed moments before the crash: converge.
      if (room.rematch && !room.rematch.locked) maybeStartNext(room);
    }
  }
}

// Replace the in-memory tables with whatever is on disk (the last flushed
// state) and re-arm their timers. No-op on a first boot with no file.
function reloadRooms() {
  for (const room of rooms.values()) {
    clearRematch(room);
    clearTimers(room);
  }
  rooms.clear();
  const loaded = loadRooms(DATA_FILE);
  for (const [code, room] of loaded) {
    rooms.set(code, room);
    rehydrateRoom(room);
  }
  return loaded.size;
}

function autoPass(room) {
  const g = room.game;
  if (g.status !== 'playing') return;
  const p = g.players[g.turn];
  if (g.drewThisTurn) {
    g.pass(g.turn);
  } else {
    g.draw(g.turn);
    g.pass(g.turn);
  }
  toast(room, `${p.name} took too long — card drawn and turn passed`);
  afterAction(room);
}

function runBot(room) {
  const g = room.game;
  if (g.status !== 'playing') return;
  const p = g.players[g.turn];
  if (!p.isBot) return;
  botMove(g, g.turn);
  afterAction(room);
}

function beginRematch(room) {
  const rm = {
    votes: new Set(),
    deadlines: new Map(),
    timers: new Map(),
    startTimer: null,
    startAt: null,
    locked: false,
  };
  for (const sid of room.humans) {
    rm.deadlines.set(sid, Date.now() + REMATCH_MS);
    rm.timers.set(
      sid,
      setTimeout(() => kickPlayer(room, sid, 'timeout'), REMATCH_MS),
    );
  }
  room.rematch = rm;
}

function maybeStartNext(room) {
  const rm = room.rematch;
  if (!rm || rm.locked) return;
  const humans = [...room.humans];
  if (humans.length === 0) {
    destroyRoom(room);
    return;
  }
  if (!humans.every((sid) => rm.votes.has(sid))) return;
  rm.locked = true;
  for (const t of rm.timers.values()) clearTimeout(t);
  rm.timers.clear();
  for (const sid of [...rm.deadlines.keys()]) rm.deadlines.delete(sid);
  broadcast(room);
  const count = room.game.discard.length;
  for (const sid of room.humans) io.to(sid).emit('reshuffle', { count });
  rm.startAt = Date.now() + RESHUFFLE_MS;
  rm.startTimer = setTimeout(() => startNextRound(room), RESHUFFLE_MS);
}

function startNextRound(room) {
  if (!rooms.has(room.code)) return;
  room.rematch = null;
  const g = room.game;
  for (let i = g.players.length - 1; i >= 0; i--) {
    const p = g.players[i];
    if (!p.isBot && !room.humans.has(p.id)) g.removePlayer(i);
  }
  g.reset();
  if (g.canStart()) {
    g.start();
    toast(room, 'New round — good luck');
  } else {
    toast(room, 'Not enough players left for a new round — back to the lobby');
  }
  afterAction(room);
}

function kickPlayer(room, sid, reason) {
  room.humans.delete(sid);
  const sock = io.sockets.sockets.get(sid);
  if (sock) {
    sock.leave(room.code);
    sock.data.room = null;
    sock.emit('kicked', { reason });
  }
  const g = room.game;
  const idx = g.playerIndexById(sid);
  if (idx >= 0) {
    if (g.status === 'playing') {
      g.players[idx].isBot = true;
      g.players[idx].name = `${g.players[idx].name} (away)`;
    } else {
      g.removePlayer(idx);
    }
  }
  const rm = room.rematch;
  if (rm) {
    const t = rm.timers.get(sid);
    if (t) clearTimeout(t);
    rm.timers.delete(sid);
    rm.deadlines.delete(sid);
    rm.votes.delete(sid);
  }
  if (room.host === sid) {
    const next = room.humans.values().next();
    room.host = next.done ? null : next.value;
  }
  if (room.humans.size === 0) return destroyRoom(room);
  if (rm && !rm.locked) maybeStartNext(room);
  if (g.status === 'playing') afterAction(room);
  else broadcast(room);
}

function afterAction(room) {
  const g = room.game;
  clearTimers(room);
  if (g.status !== 'playing') {
    if (g.status === 'over' && room.humans.size > 0) beginRematch(room);
    if (room.humans.size === 0) return destroyRoom(room);
    broadcast(room);
    return;
  }
  const cur = g.players[g.turn];
  if (cur.isBot) {
    const [min, max] = BOT_DELAY_MS;
    room.botTimer = setTimeout(() => runBot(room), min + Math.random() * (max - min));
  } else {
    room.turnDeadline = Date.now() + TURN_MS;
    room.turnTimer = setTimeout(() => autoPass(room), TURN_MS);
  }
  broadcast(room);
}

function addBot(room) {
  if (room.game.players.length >= MAX_PLAYERS) return null;
  const used = new Set(room.game.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${room.game.players.length}`;
  room.game.addPlayer(name, true);
  return name;
}

function startGame(room, cb) {
  const g = room.game;
  if (g.status === 'playing') return cb?.({ ok: false, error: 'Game already running' });
  if (!g.canStart()) return cb?.({ ok: false, error: 'Need at least 2 players' });
  g.start();
  toast(room, 'Game started — good luck');
  afterAction(room);
  cb?.({ ok: true });
}

io.on('connection', (socket) => {
  // An 'error' event with no listener would crash the process.
  socket.on('error', (err) => {
    console.error(`socket error (${socket.id}): ${err?.message || err}`);
    socket.disconnect(true);
  });

  socket.on('create', ({ name, bots = 0 } = {}, cb) => {
    // One room per socket: leaving the old room first, otherwise the
    // previous room would leak on disconnect (only the first room found
    // is ever cleaned up).
    const seated = roomOf(socket);
    if (rooms.size >= MAX_ROOMS && !seated) {
      return cb?.({ ok: false, error: 'The house is full — try again in a minute' });
    }
    if (seated) leave(false);
    const room = newRoom();
    const n = cleanName(name);
    room.game.addPlayer(n, false, socket.id);
    room.host = socket.id;
    room.humans.add(socket.id);
    socket.join(room.code);
    rooms.set(room.code, room);
    socket.data.room = room;

    const count = Math.max(0, Math.min(3, parseInt(bots, 10) || 0));
    for (let i = 0; i < count; i++) addBot(room);
    if (count > 0) {
      // Bots fill the seats, so there is nobody to wait for: skip the lobby and deal.
      room.game.players[0].ready = true;
      cb?.({ ok: true, code: room.code });
      startGame(room);
      return;
    }
    cb?.({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('join', ({ code, name } = {}, cb) => {
    if (roomOf(socket)) {
      return cb?.({ ok: false, error: 'You are already at a table — leave it first' });
    }
    const room = rooms.get(
      String(code || '')
        .trim()
        .toUpperCase(),
    );
    if (!room) return cb?.({ ok: false, error: 'No table found with that code' });
    if (room.game.status !== 'lobby')
      return cb?.({ ok: false, error: 'That game already started' });
    if (room.game.players.length >= MAX_PLAYERS)
      return cb?.({ ok: false, error: 'That table is full' });
    const n = uniqueName(room, cleanName(name));
    room.game.addPlayer(n, false, socket.id);
    room.humans.add(socket.id);
    // A restored lobby's host is a socket from the previous life — dead by
    // definition. The first human to sit down takes over the controls.
    if (!room.host || !io.sockets.sockets.has(room.host)) room.host = socket.id;
    socket.join(room.code);
    socket.data.room = room;
    cb?.({ ok: true, code: room.code });
    broadcast(room);
  });

  // A socket that dropped mid-round (network blip, laptop sleep) reconnects
  // with a new id. This hands the old seat back: the player was kept in the
  // game as `disconnected` when they dropped, so matching on the table code
  // plus their name re-attaches the fresh socket to that seat.
  socket.on('rejoin', ({ code, name } = {}, cb) => {
    if (roomOf(socket)) {
      return cb?.({ ok: false, error: 'You are already at a table — leave it first' });
    }
    const room = rooms.get(
      String(code || '')
        .trim()
        .toUpperCase(),
    );
    if (!room) return cb?.({ ok: false, error: 'No table found with that code' });
    // 'over' covers the rematch screen: the seat is still valid there, and
    // after a restart the human may be coming back to it mid-decision.
    if (room.game.status !== 'playing' && room.game.status !== 'over')
      return cb?.({ ok: false, error: 'That game is not in progress' });
    const wanted = String(name || '')
      .trim()
      .toLowerCase();
    const idx = room.game.players.findIndex(
      (p) => p.disconnected && p.name.toLowerCase() === wanted,
    );
    if (idx < 0) return cb?.({ ok: false, error: 'No seat to rejoin — the table moved on' });
    const p = room.game.players[idx];
    // Swap the seat onto the fresh socket. The old id must not linger in
    // `humans` (it would keep the room alive forever) and the host pointer
    // has to follow the seat or the host loses their controls.
    const oldId = p.id;
    p.id = socket.id;
    p.disconnected = false;
    room.humans.delete(oldId);
    room.humans.add(socket.id);
    if (room.host === oldId) room.host = socket.id;
    // On the rematch screen the seat carries a vote / deadline / timer keyed
    // by the old id — move them onto the fresh socket or the UI and the
    // timeout would act on a ghost.
    const rm = room.rematch;
    if (rm) {
      if (rm.votes.has(oldId)) {
        rm.votes.delete(oldId);
        rm.votes.add(socket.id);
      }
      const dl = rm.deadlines.get(oldId);
      if (dl !== undefined) {
        rm.deadlines.delete(oldId);
        rm.deadlines.set(socket.id, dl);
      }
      const t = rm.timers.get(oldId);
      if (t) {
        rm.timers.delete(oldId);
        rm.timers.set(socket.id, t);
      }
    }
    socket.join(room.code);
    socket.data.room = room;
    toast(room, `${p.name} is back`);
    cb?.({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on('ready', ({ on } = {}, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    if (room.game.status !== 'lobby') return cb?.({ ok: false, error: 'Only in the lobby' });
    const idx = playerIndexOf(room, socket.id);
    const p = room.game.players[idx];
    if (!p || p.isBot) return cb?.({ ok: false });
    p.ready = !!on;
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('kick', ({ index } = {}, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    if (room.host !== socket.id)
      return cb?.({ ok: false, error: 'Only the party leader can kick' });
    if (room.game.status !== 'lobby') return cb?.({ ok: false, error: 'Only in the lobby' });
    const p = room.game.players[index];
    if (!p || p.isBot || p.id === socket.id) return cb?.({ ok: false, error: 'Not a player' });
    toast(room, `${p.name} was kicked`);
    cb?.({ ok: true });
    kickPlayer(room, p.id, 'host');
  });

  socket.on('start', (_payload, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    if (room.host !== socket.id) return cb?.({ ok: false, error: 'Only the host can start' });
    if (room.game.status !== 'lobby') return cb?.({ ok: false, error: 'Game already running' });
    const waiting = room.game.players.filter((p) => !p.isBot && !p.ready);
    if (waiting.length > 0) {
      return cb?.({
        ok: false,
        error: `Waiting for ${waiting.map((p) => p.name).join(', ')} to be ready`,
      });
    }
    startGame(room, cb);
  });

  socket.on('add-bot', (_payload, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false });
    if (room.game.status !== 'lobby')
      return cb?.({ ok: false, error: 'Only before the game starts' });
    const name = addBot(room);
    if (!name) return cb?.({ ok: false, error: 'Table is full' });
    toast(room, `${name} joined the table`);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('remove-bot', ({ index } = {}, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false });
    if (room.game.status !== 'lobby')
      return cb?.({ ok: false, error: 'Only before the game starts' });
    const p = room.game.players[index];
    if (!p || !p.isBot) return cb?.({ ok: false, error: 'Not a bot' });
    room.game.removePlayer(index);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('play', ({ card, color } = {}, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    const res = room.game.playCard(playerIndexOf(room, socket.id), card, color);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    const me = room.game.players[playerIndexOf(room, socket.id)];
    if (res.unoPenalty) toast(room, `${me.name} forgot to shout UNO — drew 2 cards`);
    else if (res.penalty) {
      const victim = room.game.players[res.affected];
      toast(room, `${victim.name} drew ${res.penalty} cards`);
    }
    afterAction(room);
    cb?.({ ok: true });
  });

  socket.on('draw', (_payload, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    const res = room.game.draw(playerIndexOf(room, socket.id));
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    afterAction(room);
    cb?.({ ok: true });
  });

  socket.on('pass', (_payload, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    const res = room.game.pass(playerIndexOf(room, socket.id));
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    afterAction(room);
    cb?.({ ok: true });
  });

  socket.on('uno', (_payload, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false });
    const idx = playerIndexOf(room, socket.id);
    const res = room.game.callUno(idx);
    if (!res.ok) return cb?.({ ok: false, error: res.error });
    const me = room.game.players[idx];
    for (const sid of room.humans) io.to(sid).emit('uno-shout', { name: me.name });
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('chat', ({ text } = {}) => {
    const room = roomOf(socket);
    if (!room) return;
    // One message per CHAT_MIN_MS per socket: a spammy client must not be
    // able to re-render (and freeze) the other three tabs.
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_MIN_MS) return;
    socket.data.lastChat = now;
    const t = String(text || '')
      .trim()
      .slice(0, 200);
    if (!t) return;
    const p = room.game.players[playerIndexOf(room, socket.id)];
    const msg = { name: p ? p.name : 'Someone', text: t, ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 60) room.chat.shift();
    for (const sid of room.humans) io.to(sid).emit('chat', msg);
    persistRooms(); // chat is the one state change that bypasses broadcast
  });

  socket.on('rematch', ({ again } = {}, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false, error: 'Not at a table' });
    const rm = room.rematch;
    if (!rm || rm.locked) return cb?.({ ok: false, error: 'No rematch in progress' });
    if (room.game.status !== 'over') return cb?.({ ok: false, error: 'Game is not over' });
    if (again) {
      rm.votes.add(socket.id);
      const t = rm.timers.get(socket.id);
      if (t) clearTimeout(t);
      rm.timers.delete(socket.id);
      rm.deadlines.delete(socket.id);
      cb?.({ ok: true });
      broadcast(room);
      maybeStartNext(room);
    } else {
      cb?.({ ok: true });
      leave(false);
    }
  });

  function leave(disconnected = false) {
    const room = roomOf(socket);
    if (!room) return;
    socket.data.room = null;
    room.humans.delete(socket.id);
    socket.leave(room.code);
    const g = room.game;
    const idx = playerIndexOf(room, socket.id);
    if (idx >= 0) {
      const p = g.players[idx];
      if (g.status === 'playing') {
        if (disconnected) {
          p.disconnected = true;
        } else {
          p.isBot = true;
          p.name = `${p.name} (away)`;
        }
      } else {
        g.removePlayer(idx);
      }
    }
    const rm = room.rematch;
    if (rm) {
      const t = rm.timers.get(socket.id);
      if (t) clearTimeout(t);
      rm.timers.delete(socket.id);
      rm.deadlines.delete(socket.id);
      rm.votes.delete(socket.id);
    }
    if (room.host === socket.id) {
      const next = room.humans.values().next();
      room.host = next.done ? null : next.value;
    }
    if (room.humans.size === 0) return destroyRoom(room);
    if (rm && !rm.locked) maybeStartNext(room);
    if (g.status === 'playing') afterAction(room);
    else broadcast(room);
  }

  socket.on('leave', () => leave(false));
  socket.on('disconnect', () => leave(true));
});

// Restore tables from the previous run (no-op on a first boot).
const restored = reloadRooms();
if (restored > 0) console.log(`persist: restored ${restored} table(s) from ${DATA_FILE}`);

// Flush on the way out so a Ctrl-C or container stop never loses the last
// few seconds of play.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flushPersist();
    process.exit(sig === 'SIGINT' ? 130 : 0);
  });
}
process.on('exit', () => flushPersist());

server.listen(PORT, () => {
  console.log(`UNO table open at http://localhost:${PORT}`);
});

export { app, server, io, rooms, flushPersist, reloadRooms };
