import fs from 'node:fs';
import path from 'node:path';
import { Game } from './game.js';

// A room is plain data plus a few JS-isms (Set/Map) and live timer handles.
// This module translates between the in-memory shape and a JSON-safe shape.
// Timers are never persisted — they are rebuilt from their deadlines when
// the server comes back up (see rehydrateRoom in server.js).

export function serializeRoom(room) {
  const rm = room.rematch;
  return {
    game: room.game,
    host: room.host,
    humans: [...room.humans],
    chat: room.chat,
    turnDeadline: room.turnDeadline || 0,
    rematch: rm
      ? {
          votes: [...rm.votes],
          deadlines: [...rm.deadlines.entries()],
          locked: !!rm.locked,
          startAt: rm.startAt || null,
        }
      : null,
  };
}

export function deserializeRoom(code, plain) {
  const game = new Game();
  Object.assign(game, plain.game);
  const rm = plain.rematch
    ? {
        votes: new Set(plain.rematch.votes || []),
        deadlines: new Map(plain.rematch.deadlines || []),
        timers: new Map(),
        startTimer: null,
        startAt: plain.rematch.startAt || null,
        locked: !!plain.rematch.locked,
      }
    : null;
  return {
    code,
    game,
    host: plain.host,
    humans: new Set(plain.humans || []),
    chat: plain.chat || [],
    turnTimer: null,
    botTimer: null,
    turnDeadline: plain.turnDeadline || 0,
    rematch: rm,
  };
}

// Load all persisted rooms. A missing file (first boot) yields an empty map;
// a corrupt file must not take the server down on boot, so parse failures
// are logged and treated as "no tables".
export function loadRooms(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return new Map();
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn(`persist: could not parse ${file} (${err.message}) — starting fresh`);
    return new Map();
  }
  const rooms = new Map();
  for (const [code, plain] of Object.entries(data.rooms || {})) {
    rooms.set(code, deserializeRoom(code, plain));
  }
  return rooms;
}

// Atomic write: dump to a side file, then rename over the target, so a crash
// mid-write can never leave a truncated rooms.json behind.
export function saveRooms(file, rooms) {
  const payload = {
    version: 1,
    savedAt: Date.now(),
    rooms: {},
  };
  for (const [code, room] of rooms) {
    payload.rooms[code] = serializeRoom(room);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}
