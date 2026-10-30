# AgentReady

One script tag that makes a small-business website usable by AI agents.

People now ask assistants to "book me a haircut tomorrow at 3". Local business sites weren't built for that: agents scrape menus and get stuck on booking forms. AgentReady reads a config the owner fills in once (hours, services, prices, booking) and exposes it through [WebMCP](https://github.com/webmachinelearning/webmcp) as structured browser tools:

| Tool | Kind |
|---|---|
| `get_business_info` | read: hours, open now, address, phone |
| `get_services` | read: services with duration and price |
| `get_menu` | read: menu items with prices (restaurants, cafés; only when the config has a menu) |
| `check_availability` | read: open times for a service on a date |
| `book_appointment` | **write**: opens an on-page confirmation; nothing is booked until a human clicks Confirm. Tables take a `party_size` |

Bookings go through Cal.com. A business that takes bookings on another platform (OpenTable, Squire, Fresha…) or only by phone gets no fake booking: `check_availability` and `book_appointment` hand the customer its booking link or phone number, and nothing is booked here.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026), Indie track.

**Live:** https://davey2waveyy--agentready-web.us-east.modal.run (the public demo runs in test mode: nothing is booked on a real calendar).

## Install on a site

Run your site through the app; once it's verified you get a tag like:

```html
<script src="https://davey2waveyy--agentready-web.us-east.modal.run/agentready.js" data-site="s-…" defer></script>
```

Or self-host the config: `<script src="…/agentready.js" data-config="agentready.json" data-api="/api" defer></script>`. WebMCP only runs on HTTPS pages.

See [`public/barbershop/agentready.json`](public/barbershop/agentready.json) for the config shape. Restaurants add a read-only `menu: [{name, section, price, currency}]` and book a table instead of a service: `{"id": "table", "name": "Table reservation", "kind": "table", "minutes": 90, "maxParty": 8}` (no price; bookings over `maxParty` are refused and the agent is told to call). A midnight close is `"24:00"`.

## Run locally

```bash
npm run dev
```

Open http://localhost:3100/ for the app: paste a URL (or pick a demo), watch Muse read it, review the draft, and watch three Meta models verify it live. The demo businesses are at http://localhost:3100/barbershop/ and http://localhost:3100/salon/.

Generate and verify drive a real Chrome (Playwright, `--enable-features=WebMCPTesting`), so the app runs as one long-lived Node server, not serverless functions.

Barbershop details: with `booking.username` empty in the config, the API runs in mock mode (fake slots, fake bookings, responses flagged `mock: true`). Set it to a Cal.com username, and optionally `CAL_API_KEY` in `.env`, for real bookings.

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

Three different Meta models (`muse-spark-1.3`, `muse-wonder-1.0`, `muse-spark-1.2`) act as skeptics. Each runs 7 customer tasks (hours, prices, live availability, booking, declined booking, booking on a closed day) against the site, and every answer is checked mechanically against the owner's config and the live booking system. Then it runs the same tasks against a **broken twin** (stale prices and hours, booking backend down, consent dialog auto-approving). A business that books on another platform or by phone is tested on the handoff instead: the agent must give the customer the real booking link or number without claiming a booking, and its twin serves an old link or number. The site is only "verified" if every skeptic passes it and catches the twin on every fault. `--models muse-spark-1.3` runs one model; `npm run gauntlet -- salon` tests the salon. Runs in mock mode, so nothing is really booked. Report goes to `reports/`.

To verify a generated draft before it goes live: `npm run gauntlet -- --config reports/draft-….json`. If the site hasn't installed AgentReady, the test browser adds the script tag itself, so nothing on the owner's site changes until they approve.

## Real sites

8 real Hamilton, Ontario businesses, read from their public websites on Oct 27, 2026. Nobody was contacted and nothing was booked: verify runs every booking against a test calendar.

| Business | Type | Built with | Pages read | Hours | Prices found | Booking found | Owner questions |
|---|---|---|---|---|---|---|---|
| Glassbox Barbershop | barber | Shopify | 5 | ✓ | 3/3 | Squire | 11 |
| Ky & Co. Barbershop | barber | Wix | 1 | ✓ | 0/6 | Squire | 3 |
| Revelry Beauty Bar | beauty | Shopify | 5 | ✓ | 0/5 | Phorest | 7 |
| Chosen Canvas | beauty | Squarespace | 5 | by appointment | 3/3 (from Fresha) | Fresha | 7 |
| Berkeley North | restaurant | Squarespace | 5 | ✓ | 22 menu items | — | 8 |
| Electric Diner | restaurant | WordPress | 5 | ✓ | — | OpenTable | 7 |
| HAMBRGR | restaurant | custom | 5 | ✓ | 56 menu items (from menu photos) | OpenTable | 9 |
| The Burnt Tongue | restaurant | Squarespace | 1 | ✓ | 0/4 | Toast | 6 |

Muse never invents a value: when a site doesn't say (most shops keep prices on their booking platform), it leaves the field empty and asks the owner. It also caught real contradictions the owners would want to know about, like a footer and a contact page listing different hours.

**Verified by all 3 models on Oct 27, broken twin caught 3/3 every time:** Glassbox Barbershop, Ky & Co. Barbershop, Electric Diner, HAMBRGR (menu prices quoted via `get_menu`). Those runs booked against a test calendar, as if each shop used Cal.com. None of them does (they book on Squire or OpenTable), so the test now checks that agents hand customers their real booking link instead, and these four need re-running. For those runs we filled only the blanks the owner normally fills at review (durations, Ky & Co's prices from its public Squire listing, and how long a table is held and the largest online party for the restaurants). Everything else came from the sites.

What real sites taught us, now fixed: booking buttons link to dozens of platforms (Muse now sees every outside link instead of a fixed list), prices often live only on the booking page (the reader now opens one booking page), images lazy-load (it scrolls first), and a blocked page used to derail the rest of the crawl. Not fixed: Squire and OpenTable block automated browsers, so those prices come from the owner.

## Layout

- `public/agentready.js` — the drop-in script (no build step)
- `public/barbershop/` — demo business site with AgentReady installed, + its config
- `public/salon/` — second demo business, not installed: menu only as an image, hours in prose
- `api/` — request handlers: slots/book (Cal.com API v2, one config per business `site`), generate/verify (background jobs), job (resumable event stream), config
- `agent/` — Muse Spark agent runner, config generator, verification gauntlet
- `dev.mjs` — the Node server (local and hosted)
- `modal_app.py` — hosting: one Modal container with Node + Chrome, configs saved to a Modal Volume. `modal deploy modal_app.py` (needs a Modal secret `agentready` with `MODEL_API_KEY`)

## Prior work

I previously shipped WebMCP tools in an earlier project, BetaTrace. No code from BetaTrace is used here. Everything in this repository was written from scratch starting October 26, 2026, during the hackathon.

## License

MIT
