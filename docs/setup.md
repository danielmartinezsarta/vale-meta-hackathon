# Setup

## Prerequisites

- Node 20 or newer.
- Your own Meta API key for live runs. No key needed for the recorded replay.

## Environment

Copy the example and fill it in. Never commit `.env`.

```bash
cp .env.example .env
```

| Variable | Required | What it does |
|---|---|---|
| `META_API_KEY` | For live runs | Server-side key for Meta models. The browser never sees it. |
| `GLIMMER_URL` | No | URL of your own Glimmer deploy (`modal deploy modal/glimmer.py`). Empty keeps private briefs off; cards still open. |
| `GLIMMER_TOKEN` | No | Bearer token for that endpoint. Export it in the shell; it never goes in the file. |
| `SEAMLESS_URL` | No | URL of your own SeamlessM4T v2 Large deploy (`modal deploy modal/seamless.py`). Empty keeps the engine off; the browser voice says every line. |
| `SEAMLESS_TOKEN` | No | Bearer token for that endpoint. Export it in the shell; it never goes in the file. The voice switch stays disabled without URL and token. |

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
cp .env.example .env
npm run replay
```

This is the clearly labeled mock-data path: it plays `replay/demo-run.json` end to end through the real app. Every reply spoken with the browser voice, every sheet shown, labeled “Replay: recorded run” with turn counters. No key, no network, no secrets in the file (health notes travel masked).

To record a fresh run from live turns, see [recording a replay](#recording-a-replay).

Without a key and without replay, the app says so on screen in the active language instead of starting voice.

## Recording a replay

Needs a running live server with your key, on a fresh database (`npm run db:reset`, then start the server):

```bash
npm run replay:record
```

It posts each scripted line as a typed turn through the real app and folds the log into `replay/demo-run.json`, with transcripts, tool calls, answers and widgets, no audio and no secrets.

The run caps itself at 0.50 USD of model calls.

## Tests

```bash
npm test
```

Unit, route and component tests: voice turns, photo preview, agenda, pricing, sheets and the replay player.
