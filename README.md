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

### Verification gauntlet

```bash
npm run gauntlet
```

A Muse Spark agent runs 7 customer tasks (hours, prices, live availability, booking, declined booking, booking on a closed day) against the site, and every answer is checked mechanically against the owner's config and the live booking system. Then it runs the same tasks against a **broken twin** (stale prices and hours, booking backend down, consent dialog auto-approving). The site is only "verified" if it passes and the twin is caught on every fault. Runs in mock mode, so nothing is really booked. Report goes to `reports/`.

## Layout

- `public/agentready.js` — the drop-in script (no build step)
- `public/barbershop/` — demo business site + its config
- `api/slots.js`, `api/book.js` — Vercel functions proxying Cal.com API v2
- `dev.mjs` — local server that mimics Vercel

## Prior work

I previously shipped WebMCP tools in an earlier project, BetaTrace. No code from BetaTrace is used here. Everything in this repository was written from scratch starting October 26, 2026, during the hackathon.

## License

MIT
