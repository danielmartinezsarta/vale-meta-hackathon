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

## License

[Apache-2.0](LICENSE)
