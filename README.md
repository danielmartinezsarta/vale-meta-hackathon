# Vale (hackathon build)

## What was built during the hackathon

Started 2026-10-27. Today this holds the base app (Next.js + TypeScript) with a one-tap microphone screen.

Everything here is new: this repository was created on October 26, 2026 with only the license and this README, and all code was written from October 27, 2026 onward, during the hackathon window (October 26 to November 4, 2026). No code, data, prompts, or assets from earlier projects are included, and any data used is invented.

The idea comes from first-hand knowledge of the trade: nail technicians work with their hands full and no free moment to type, so this build explores a hands-free, voice-first helper for them.

Hands-free, voice-first assistant for entrepreneurs who work with their hands, starting with nail technicians.

## How a price is quoted (all invented)

When asked how much to charge, Vale adds four parts and says each one out
loud: the supplies used, the work time, a share of the monthly fixed costs,
and the margin. The hourly rate and the fixed share both come from the
workable minutes of the current month (its Monday-to-Friday days, eight
hours a day), so no rate is written by hand. The final figure rounds up
to the tens, and the rounding difference counts toward the 2500 USD
monthly goal: closing a session saves its margin, and "how am I doing
on the goal" reports the month's sum against 2500.

supplies = sum over the recipe of (quantity × product price / product content)
time = minutes × (monthly goal / workable minutes)
fixed share = minutes × (monthly fixed costs / workable minutes)
price = round_up((supplies + time + fixed share) × (1 + margin))

The agenda and the stock follow the same spoken rule: appointments are
created, listed and moved by voice, and the stock only moves when she says
so ("I bought two", "three left", "it's gone"). Logging supplies for a
session never touches the stock. Weekend or after-hours bookings warn
first ("heads up, that's outside 9 to 5") and still run.

## Demo data (all invented)

Client, service and supply names come from `src/lib/seed-data.json` and are
entirely fictitious, created for this hackathon. The SQLite file
(`data/vale.db`, created by `npm run db:seed` and never committed) holds only
that invented seed. Health notes are stored flagged as private and are never
shown or sent to the cloud model.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie Developer track, "Build for Your World"), October 26 to November 4, 2026.

## Private client briefs (open weights)

Client records are only read by an open-weights Meta model on infrastructure
we run. The cloud assistant handles the business and never sees the client's
private details: "tell me about David" speaks a precomputed brief and opens
the card with the summary on top, labeled "Prepared privately by Muse Glimmer
(open weights)". Without a private model the card still opens, with the
sentence "I don't have a private model set up to read client records, so
here's David's card."

Deploy the model from `modal/glimmer.py` (warm brief ~19 s, about $0.006
per brief, $0 while idle):

```
modal deploy modal/glimmer.py  # serve and serve_draft (drafter, faster)
modal app stop vale-glimmer    # scale to zero when done
```

Production uses the drafter endpoint
(`https://<username>--vale-glimmer-serve-draft.us-east.modal.run`).
Set it as `GLIMMER_URL` (see `.env.example`) and export `GLIMMER_TOKEN`
from the Modal secret, in the local .env (gitignored) or the shell; the token never lives in the repo.

The same endpoint runs locally with `llama-server` and the GGUF weights
from `meta-models/Muse-Glimmer-30B-GGUF`
(`Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`, plus the dflash drafter for
the fast path), with the flags from the model card (`--jinja`, `-ngl 99`,
low reasoning strength, `--reasoning-budget 512`, temp 1.0, top-p 0.95,
top-k 64), then `GLIMMER_URL=http://127.0.0.1:8080`. The app precomputes
briefs on server start and after `npm run db:reset` for the clients with
appointments today; a new note or a closed session regenerates that
client's brief in the background.

## Replay: watch the recorded demo (no key)

`npm run replay` serves the committed recording from `replay/demo-run.json`
with no model calls and no key: build once, then play it on port 3222.

```
npm install
npm run build
npm run replay
```

Then open http://localhost:3222 in a browser. Every scene carries a
visible `Replay: <scene>` label while its turns play, with the browser
voice reading Vale's recorded replies. To record a new run, reset an
isolated database and fold the filtered log (never hand-edit the file):

```
VALE_DB_PATH=/tmp/vale-replay.db PORT=3222 npm run db:reset
PORT=3222 VALE_DB_PATH=/tmp/vale-replay.db tsx --env-file=.env server.ts
REPLAY_BASE=http://localhost:3222 VALE_DB_PATH=/tmp/vale-replay.db REPLAY_BANNED_WORDS=... npm run replay:record
```

`REPLAY_BANNED_WORDS` is an optional comma-separated blocklist (kept in
the shell, never committed): the recording fails if a reply contains one
of those words.

## Voice (Seamless, optional)

The demo speaks with the browser voice unless `SEAMLESS_URL` is set. To serve
the open model yourself: `pip install modal`, then
`SEAMLESS_APP_NAME=vale-seamless-<something-private> modal deploy modal/seamless.py`,
then copy the printed https URL into your local `.env` as `SEAMLESS_URL`.

## License

[Apache-2.0](LICENSE)
