# AgentReady

One script tag that makes a small-business website usable by AI agents.

People now ask assistants to "book me a haircut tomorrow at 3". Local business sites weren't built for that: agents scrape menus and get stuck on booking forms. AgentReady reads a config the owner fills in once (hours, services, prices, booking) and exposes it through [WebMCP](https://github.com/webmachinelearning/webmcp) as structured browser tools:

| Tool | Kind |
|---|---|
| `get_business_info` | read: hours, open now, address, phone |
| `get_services` | read: services with duration and price |
| `check_availability` | read: open times for a service on a date |
| `book_appointment` | **write**: opens an on-page confirmation; nothing is booked until a human clicks Confirm |

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026), Indie track.

## Install on a site

```html
<script src="https://YOUR-DEPLOY/agentready.js" data-config="agentready.json" data-api="/api" defer></script>
```

See [`public/barbershop/agentready.json`](public/barbershop/agentready.json) for the config shape.

## Run locally

```bash
npm run dev
```

Open http://localhost:3100/barbershop/. With `booking.username` empty in the config, the API runs in mock mode (fake slots, fake bookings, responses flagged `mock: true`). Set it to a Cal.com username, and optionally `CAL_API_KEY` in `.env`, for real bookings.

To see the tools as an agent does, start Chrome with `--enable-features=WebMCPTesting` (or `chrome://flags/#enable-webmcp-testing`) and run `await document.modelContext.getTools()` in the console.

```bash
npm test
```

### Generate a config from a site

```bash
npm run generate                # the demo barbershop, scored against its hand-written config
npm run generate -- salon       # the messy demo salon: prices only in a photo of its chalkboard menu, hours in a paragraph
npm run generate -- <url>       # any site
```

Muse Spark reads up to 4 pages of the site (text, JSON-LD, booking links and a full-page screenshot of each, with AgentReady itself blocked so it sees the site as it was) and drafts `agentready.json`. Every value has to come from the site: anything it doesn't state is left empty and becomes a question for the owner, and each field cites where it was found. Format errors get one repair round. The draft goes to `reports/draft-*.json`; it isn't live until the owner approves it.

### Verification gauntlet

```bash
npm run gauntlet
```

Three different Meta models (`muse-spark-1.3`, `muse-wonder-1.0`, `muse-spark-1.2`) act as skeptics. Each runs 7 customer tasks (hours, prices, live availability, booking, declined booking, booking on a closed day) against the site, and every answer is checked mechanically against the owner's config and the live booking system. Then it runs the same tasks against a **broken twin** (stale prices and hours, booking backend down, consent dialog auto-approving). The site is only "verified" if every skeptic passes it and catches the twin on every fault. `--models muse-spark-1.3` runs one model; `npm run gauntlet -- salon` tests the salon. Runs in mock mode, so nothing is really booked. Report goes to `reports/`.

To verify a generated draft before it goes live: `npm run gauntlet -- --config reports/draft-….json`. If the site hasn't installed AgentReady, the test browser adds the script tag itself, so nothing on the owner's site changes until they approve.

## Layout

- `public/agentready.js` — the drop-in script (no build step)
- `public/barbershop/` — demo business site with AgentReady installed, + its config
- `public/salon/` — second demo business, not installed: menu only as an image, hours in prose
- `api/slots.js`, `api/book.js` — Vercel functions proxying Cal.com API v2, one config per business (`site`)
- `agent/` — Muse Spark agent runner, config generator, verification gauntlet
- `dev.mjs` — local server that mimics Vercel

## Prior work

I previously shipped WebMCP tools in an earlier project, BetaTrace. No code from BetaTrace is used here. Everything in this repository was written from scratch starting October 26, 2026, during the hackathon.

## License

MIT
