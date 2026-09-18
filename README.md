# UNO — the card table

A real-time multiplayer UNO you can run anywhere. Create a table, share the 4-letter code, and play with 2–4 people — or pad the table with bots. Includes chat, a 30-second turn timer, and the full UNO ruleset (skip, reverse, draw-2, wild, wild-4, and the "forgot to say UNO" penalty).

## Requirements

Node.js 18+ (developed on Node 22).

## Get started

```bash
npm install
npm start
```

Then open http://localhost:3000 in a browser (one tab per player — or use the bots). Set a custom port with `PORT=8080 npm start`.

## Docker

```bash
docker compose up --build
```

Builds a minimal Node 22 image (non-root, with a `/api/health` healthcheck) and serves the game at http://localhost:3000.

## How to play

1. Pick a name, add 0–3 bots if you're feeling lonely, and **Create table**.
2. Share the 4-letter code. Friends **Join** with that code and a name.
3. Everyone hits **Ready** — the party leader (creator) can also kick players out of the lobby — then the leader hits **Deal**.
4. Match the top card by color or value, play action cards, pick colors for wilds, and — when you're down to one card — press **UNO** before you play it, or you'll draw two as a penalty.
5. First player to empty their hand (after a proper UNO shout) wins.
6. After every round, each player chooses **Play again** or **Leave** — you get 30 seconds, and if you don't pick, the table moves on without you. When everyone is in, the played cards fly up, get mixed, and the next round deals itself.

Every seat has a 30-second turn timer; run it out and you draw a card and pass.

## Commands

| Command       | What it does                                  |
| ------------- | --------------------------------------------- |
| `npm start`   | Run the server (Express + Socket.IO)          |
| `npm run dev` | Run with auto-reload (`node --watch`)         |
| `npm test`    | Engine unit tests + full-game integration tests |

## Stack

Express 4, Socket.IO 4, and a vanilla JS client — no build step, no framework. The rules engine (`lib/game.js`) is pure and framework-free, which is what makes it easy to test and to lift into other projects.

## Project layout

- `server.js` — rooms, socket handlers, turn timers, bots
- `lib/game.js` — the rules engine
- `lib/cards.js`, `lib/bot.js` — deck + a decent-enough opponent
- `public/` — the game UI
- `test/` — `node:test` suites
