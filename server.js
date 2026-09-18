import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { Game, COLORS } from './lib/game.js';
import { botMove } from './lib/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

const MAX_PLAYERS = 4;
const TURN_MS = 30000;
const REMATCH_MS = Number(process.env.REMATCH_MS) || 30000;
const RESHUFFLE_MS = 1800;
const BOT_DELAY_MS = [1000, 2200];
const BOT_NAMES = ['Ruby', 'Milo', 'Vera', 'Otis', 'Nova', 'Juno'];

const rooms = new Map();

function genCode(len = 4) {
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

function roomOf(socket) {
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
  for (const sid of room.humans) io.to(sid).emit('state', stateFor(room, io.sockets.sockets.get(sid)));
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
  const rm = { votes: new Set(), deadlines: new Map(), timers: new Map(), startTimer: null, locked: false };
  for (const sid of room.humans) {
    rm.deadlines.set(sid, Date.now() + REMATCH_MS);
    rm.timers.set(sid, setTimeout(() => kickPlayer(room, sid, 'timeout'), REMATCH_MS));
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
  socket.on('create', ({ name, bots = 0 } = {}, cb) => {
    const room = newRoom();
    const n = cleanName(name);
    room.game.addPlayer(n, false, socket.id);
    room.host = socket.id;
    room.humans.add(socket.id);
    socket.join(room.code);
    rooms.set(room.code, room);

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
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, error: 'No table found with that code' });
    if (room.game.status !== 'lobby') return cb?.({ ok: false, error: 'That game already started' });
    if (room.game.players.length >= MAX_PLAYERS) return cb?.({ ok: false, error: 'That table is full' });
    const n = cleanName(name);
    room.game.addPlayer(n, false, socket.id);
    room.humans.add(socket.id);
    socket.join(room.code);
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
    if (room.host !== socket.id) return cb?.({ ok: false, error: 'Only the party leader can kick' });
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
      return cb?.({ ok: false, error: `Waiting for ${waiting.map((p) => p.name).join(', ')} to be ready` });
    }
    startGame(room, cb);
  });

  socket.on('add-bot', (_payload, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false });
    if (room.game.status !== 'lobby') return cb?.({ ok: false, error: 'Only before the game starts' });
    const name = addBot(room);
    if (!name) return cb?.({ ok: false, error: 'Table is full' });
    toast(room, `${name} joined the table`);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('remove-bot', ({ index } = {}, cb) => {
    const room = roomOf(socket);
    if (!room) return cb?.({ ok: false });
    if (room.game.status !== 'lobby') return cb?.({ ok: false, error: 'Only before the game starts' });
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
    const t = String(text || '').trim().slice(0, 200);
    if (!t) return;
    const p = room.game.players[playerIndexOf(room, socket.id)];
    const msg = { name: p ? p.name : 'Someone', text: t, ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 60) room.chat.shift();
    for (const sid of room.humans) io.to(sid).emit('chat', msg);
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

server.listen(PORT, () => {
  console.log(`UNO table open at http://localhost:${PORT}`);
});

export { app, server, io, rooms };
