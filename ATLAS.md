# ATLAS.md — UNO card table

Real-time multiplayer UNO. Express + Socket.IO backend, vanilla JS client (no framework). 2–4 humans per table, optional bots, chat, room codes.

## Run / test
- `npm install`
- `npm start` (or `npm run dev` for watch) — serves `public/` + Socket.IO. `PORT` env overrides (default 3000).
- `npm test` — `node --test` suite. Engine unit tests (`test/engine.test.js`) + socket.io-client integration that plays full games to a winner (`test/flow.test.js`). All 13 pass.
- Health: `GET /api/health` → `{"ok":true}`.
- Docker: `docker compose up --build` — `Dockerfile` (node:22-alpine, non-root, healthcheck) + `docker-compose.yml` (port 3000). `.dockerignore` excludes node_modules/test.

## Layout
- `server.js` — Express static + Socket.IO rooms. One `rooms` Map keyed by 4-char code. Exports `{ app, server, io, rooms }` for tests.
- `lib/game.js` — pure rules engine (`Game` class), no I/O.
- `lib/cards.js` — deck build (108 cards), shuffle, `isWild`.
- `lib/bot.js` — `botMove(game, idx)` greedy card picker; mutates the game directly (server is single-threaded).
- `public/` — `index.html` (menu → lobby → table screens), `style.css` (felt-table aesthetic), `app.js` (socket client + renderers).
- `test/` — node:test suites.

## Key conventions / gotchas (learned the hard way)
- **Socket ack order is `(payload, cb)` everywhere.** The client `emit()` helper and the test `emitAck()` always send a payload first. Server handlers that take no payload use `(_payload, cb)`. Do NOT write `(cb)` — the payload lands in `cb` and `cb?.()` throws.
- **`isPlayable(card, hand)`** needs the hand: wild4 is only legal if the player holds no card of the current color. `playableCards(hand)` threads the hand through.
- **`playCard` applies the card effect first, then handles UNO/win.** A skipped/penalized last card still resolves its effect. Don't reorder.
- **Reverse:** flips direction, then `advance(players.length === 2 ? 2 : 1)`. Two players → acts as a skip (turn returns to the player). 3+ → moves to the next seat against the new direction.
- **Turn/UNO:** `unoCalled` must be true to win on an empty hand; otherwise the player draws 2 (penalty). Bots auto-call UNO when they hit 1 card.
- **Test state races:** attach a persistent `socket.on('state')` tracker *before* the first broadcast, or the initial state is missed and `awaitState` times out. The server broadcasts state before resolving the ack, so a cached `_st` is fresh after `emitAck` resolves.

## Design identity (keep it consistent)
Felt-green table, wooden rail, UNO palette (red #e5311b, yellow #f2a900, green #009a4d, blue #0669b0), paper #f5f2e8, ink #10131a. Display: Archivo italic 800/900. Body: Instrument Sans. Cards = colored field + tilted oval tinted 50% card color / ink (`color-mix`) + white face — the tint is what makes hand cards identifiable by color. See `:root` tokens in `style.css`.

## Open / next
- Git repo: https://github.com/ufz0/uno-game (public, branch `main`) — commit + push after changes.
- No lint/typecheck configured. No persistence (rooms are in-memory, lost on restart).
