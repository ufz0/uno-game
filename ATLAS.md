# ATLAS.md — UNO card table

Real-time multiplayer UNO. Express + Socket.IO backend, vanilla JS client (no framework). 2–4 humans per table, optional bots, chat, room codes.

## Git rule (user instruction — this project only)
- **Commit only to `dev`. Never commit to `main`.** All feature work happens on `dev`; `main` is updated only via PRs. This rule was given for this repo and applies to no other project.
- Repo: https://github.com/ufz0/uno-game (public). Push `dev` after changes; `dev` is the live branch. `main` tracks `dev` via PRs (#1–#3 merged); `dev` is normally only ahead by pending doc commits until the next merge.

## Run / test
- `npm install`
- `npm start` (or `npm run dev` for watch) — serves `public/` + Socket.IO. `PORT` env overrides (default 3000).
- `npm test` — `node:test` suite. Engine unit tests (`test/engine.test.js`) + socket.io-client integration that plays full games to a winner (`test/flow.test.js`) + a room-cap test (`test/cap.test.js`). All 21 pass. The full suite takes ~2 minutes — `flow` plays real games on real timers; don't mistake that for a hang.
- CI: `.github/workflows/ci.yml` — GitHub Actions runs `npm ci && npm test` (node 22, matching the Docker image) on pushes to `dev`/`main` and PRs targeting `main`.
- Health: `GET /api/health` → `{"ok":true}`.
- Docker: `docker compose up --build` — `Dockerfile` (node:22-alpine, non-root, healthcheck) + `docker-compose.yml` (port 3000). `.dockerignore` excludes node_modules/test.

## Layout
- `server.js` — Express static + Socket.IO rooms. One `rooms` Map keyed by 6-char code. Exports `{ app, server, io, rooms }` for tests.
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
- **Lobby is for party tables only.** `create` with bots > 0 deals straight away (creator is marked ready, `startGame` runs inside the create handler — no ready-up, no lobby). Party tables (the "Party" chip, 0 bots) wait in the lobby: every human must emit `ready {on:true}` before the host's `start` is accepted; bots count as ready. `stateFor` carries `allReady` + per-player `ready` for the UI.
- **`#over` starts `hidden` in the HTML.** `renderOver` must set `over.hidden = false` on a normal game end (the `kicked` handler does it for the kicked screen). This was the "game won but the table just sits still" bug — the win screen was never unhidden, in any player count or outcome.
- **Security posture (2026-09 audit):** one room per socket — `create` auto-leaves the current room first, `join` refuses if already seated (otherwise a socket sat in many rooms and only the first was cleaned up on disconnect → leak/DoS). `MAX_ROOMS` (env, default 100) caps tables; a seated socket may still move to a fresh table at the cap. Room codes are 6 chars from a 32-char set (~1.07B) so probing for live lobbies via `join` is impractical. `broadcast` skips stale socket ids and a socket-level `error` listener disconnects — an uncaught exception anywhere kills the whole process and every table. HTTP responses carry a CSP (every source locked to `'self'`; the only exceptions are `fonts.googleapis.com`/`fonts.gstatic.com` for Google Fonts, plus `object-src 'none'` and `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, and `X-Powered-By` is off. Client XSS surface is handled: every user-controlled string (names, chat) goes through `esc()` before `innerHTML`, the rest use `textContent`.
- **Rematch flow (server-driven):** on `status === 'over'` the room gets a `room.rematch` with a per-human 30s timeout (`REMATCH_MS`, env-overridable — tests set it to 4000). `rematch {again:true}` records a vote and clears that player's timer; `{again:false}` routes to `leave()`. When every remaining human has voted, `maybeStartNext` locks (clears all timers — this is the "skip the rest"), broadcasts, emits `reshuffle {count}` to each human, and starts the next round after `RESHUFFLE_MS` (1800, the client's animation window). Timed-out humans are kicked via `kickPlayer(room, sid, 'timeout')`.
- **`kickPlayer` is the single removal path** for kicked/timeout players: removes from `room.humans`, emits `kicked {reason:'host'|'timeout'}` to the victim, drops the seat (or bot-takes-over mid-game), transfers host if needed, and re-evaluates the rematch. Any new removal path should go through it.
- **Room teardown goes through `destroyRoom`** (clears rematch timers + start timer + turn/bot timers, deletes from `rooms`). A room is destroyed whenever `room.humans.size === 0` — even mid-game (previously a all-bots room would leak and play forever).
- **Ghost seats:** `startNextRound` drops human seats whose socket is no longer in `room.humans` before dealing; if that leaves <2 players the table falls back to the lobby instead of starting.
- **Client reshuffle animation** is WAAPI (`el.animate`) on card backs spawned in `#shuffle-layer`; triggered by the `reshuffle` socket event, cleaned up when the next `playing` state lands. Don't gate it on state alone — the `locked` state and the event arrive together, and the event is the one-shot trigger.
- **Opponent hands are client-rendered fans of card backs** (`renderOpps` in `app.js`): each opponent gets an area on the felt (top for 1, top corners for 2, left/top/right for 3) with a name label, live count, and a gold turn glow. A play is detected as "`st.top` changed and the previous state's `turn` was this opponent" — their middle back flies to the discard; count gains get the `just-in` pop. The fan DOM *is* the state (count = child element count, self-healing after missed states) and `#opps` is rebuilt on a fresh deal. Gotchas: `dataset` values are strings — key opponent elements by `String(p.index)`, or a duplicate element spawns on every state. And `S.prevState` must be assigned at the *top* of `onState` (before any renderer runs) — if it lags one state behind, the flight animates on the wrong turn (or never), which looks like "animations only play on my own plays".

## Design identity (keep it consistent)
Felt-green table, wooden rail, UNO palette (red #e5311b, yellow #f2a900, green #009a4d, blue #0669b0), paper #f5f2e8, ink #10131a. Display: Archivo italic 800/900. Body: Instrument Sans. Cards = colored field + tilted oval tinted 50% card color / ink (`color-mix`) + white face — the tint is what makes hand cards identifiable by color. See `:root` tokens in `style.css`.

## Open / next
- 3D table was attempted 2026-09 (three.js + cannon-es on `feature/3d-table`, physics fully working, 31 tests) — the user rejected the look and the branch was deleted (commits still in local reflog if ever wanted back). Do not retry 3D without the user asking.
- Lint/typecheck not configured. No persistence (rooms are in-memory, lost on restart).
- The server speaks plain HTTP — put a TLS-terminating proxy (Caddy/nginx) in front when exposing it beyond the LAN.
- Lobby kick is humans-only (bots have their own remove control). Post-game, humans only choose again/leave — there is no host override by design.
