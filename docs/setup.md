# Setup

## Prerequisites

- Node 20 or newer.
- Your own Meta API key for live runs. No key needed for the recorded replay.

## Environment

Copy the example and fill it in. Never commit `.env`.

```bash
cp .env.example .env
```

Secrets live in local `.env` (gitignored, never committed) or in the shell. `npm start` loads `.env` when the server boots. The `db:reset` brief precompute reads the shell environment, so export Glimmer values there before resetting if you want briefs.

| Variable | Required | What it does |
|---|---|---|
| `META_API_KEY` | For live runs | Server-side key for Meta models. The browser never sees it. |
| `GLIMMER_URL` | No | URL of your own Glimmer deploy (`modal deploy modal/glimmer.py`). Empty keeps private briefs off; cards still open. |
| `GLIMMER_TOKEN` | No | Bearer token for that endpoint. Local `.env` or shell; never in the repo. |
| `SEAMLESS_URL` | No | URL of your own SeamlessM4T v2 Large deploy (`modal deploy modal/seamless.py`). Empty keeps the engine off; the browser voice says every line. |
| `SEAMLESS_TOKEN` | No | Bearer token for that endpoint. Local `.env` or shell; never in the repo. The voice switch stays disabled without URL and token. |

Deploy details for both backends: [modal.md](modal.md).

## Run

```bash
npm install
npm run db:reset
npm start
```

`db:reset` wipes and reseeds the demo database in seconds: a neutral Demo user with relative dates (David at 3 PM with his latex note and photo, Sofia, Paola, the month goal, acetone and cleaning reminders).

Precomputing the private briefs never throws: without Glimmer configured the cards simply open without them.

`npm start` builds, then prints the URL. Open it and tap the microphone. Try: “Starting a gel refill with David”, then “How much does David pay?”

## Replay without a key

```bash
npm install
npm run build
npm run demo
```

This is the clearly labeled mock-data path: it plays `replay/demo-run.json` through the real app in a headed browser — open the app, wake Vale, type every recorded turn, one voice at a time. A slim pill tracks the run and prints the scene name per turn. No key needed.

To record a fresh run from live turns, see [recording a replay](#recording-a-replay).

Without a key and without replay, the app says so on screen in the active language instead of starting voice.

## Recording a replay

Reset an isolated database and fold the filtered log (never hand-edit the file):

```bash
VALE_DB_PATH=/tmp/vale-replay.db PORT=3222 npm run db:reset
PORT=3222 VALE_DB_PATH=/tmp/vale-replay.db tsx --env-file=.env server.ts
REPLAY_BASE=http://localhost:3222 VALE_DB_PATH=/tmp/vale-replay.db REPLAY_BANNED_WORDS=... npm run replay:record
```

`REPLAY_BANNED_WORDS` is an optional comma-separated blocklist (kept in the shell, never committed): the recording fails if a reply contains one of those words.

The run caps itself at 2.00 USD of model calls.

## Tests

```bash
npm test
```

Unit, route and component tests: voice turns, photo preview, agenda, pricing, sheets and the replay player.
