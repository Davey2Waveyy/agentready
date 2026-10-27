// Generate: Muse Spark reads a business website (page text + screenshots) and drafts its agentready.json.
// The draft is not live until the owner reviews it; `questions` lists what the site didn't say.
// npm run generate                 (the demo barbershop, scored against its hand-written config)
// npm run generate -- salon        (the messy demo salon: prices only in a photo of its menu board)
// npm run generate -- <url>        (any site)
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LLM } from './run.mjs';
import { demoServer } from './gauntlet.mjs';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SOCIAL = /instagram|facebook|tiktok|twitter|x\.com|youtube|pinterest|linkedin|google\.|wix\.com|squarespace\.com|shopify\.com|^mailto:|^tel:/i;
const USEFUL = /servic|price|menu|rate|hour|book|reserv|appoint|contact|visit|about|location/i;

// Up to maxPages pages: the site's most useful pages plus its booking page. Text, JSON-LD, booking links and a screenshot of each.
export async function crawl(url, { maxPages = 5 } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.route(/agentready\.(js|json)/, (r) => r.abort()); // read the site as it is before AgentReady is installed
  const pages = [], seen = new Set(), queue = [url];
  let booked = false;
  try {
    while (queue.length && pages.length < maxPages) {
      const u = queue.shift().split('#')[0];
      if (seen.has(u)) continue;
      seen.add(u);
      // a fresh tab per page: a blocked page (OpenTable refuses headless Chrome) leaves an error page that hijacks the next goto
      const page = await context.newPage();
      if (!(await page.goto(u).catch(() => null))?.ok()) { await page.close(); continue; }
      // scroll through so lazy-loaded images (Wix, Squarespace) are in the screenshot
      await page.evaluate(async () => { for (let y = 0; y < Math.min(document.body.scrollHeight, 6000); y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } scrollTo(0, 0); });
      await page.waitForTimeout(500); // late JS widgets
      const d = await page.evaluate(() => ({
        title: document.title,
        text: document.body.innerText,
        jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.trim()),
        links: [...document.links].map((a) => ({ href: a.href, text: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) }))
          .concat([...document.querySelectorAll('iframe[src]')].map((f) => ({ href: f.src, text: '(embedded)' }))),
      }));
      // ponytail: screenshot capped at 6000px tall; tile it if long menus get cut off
      const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 6000);
      const shot = (await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true, clip: { x: 0, y: 0, width: 1100, height } })).toString('base64');
      await page.close();
      const origin = new URL(url).origin;
      // Booking platforms are endless (Squire, Phorest, Tock, Toast…), so Muse sees every outside link and decides.
      const outside = [...new Map(d.links.filter((l) => /^https?:/.test(l.href) && !l.href.startsWith(origin) && !SOCIAL.test(l.href)).map((l) => [l.href.split('?')[0], l])).values()].slice(0, 30);
      pages.push({ url: u, title: d.title, text: d.text.slice(0, 12_000), jsonld: d.jsonld, outside, shot });
      queue.push(...d.links.filter((l) => l.href.startsWith(origin) && l.text !== '(embedded)' && USEFUL.test(l.href + ' ' + l.text)).map((l) => l.href));
      // Real shops often list prices only on their booking page (Squire, Fresha, Phorest…): read one, but never crawl that site.
      const bookAt = !booked && outside.find((l) => /book|appoint|reserv/i.test(l.text) && !/\.pdf$/i.test(l.href.split('?')[0]));
      if (bookAt) { booked = true; queue.unshift(bookAt.href); }
    }
  } finally {
    await browser.close();
  }
  return pages;
}

const PROMPT = `You turn a small business's website into a config file that AI agents use to answer customers and book appointments.
Customers will rely on it, so every value must come from the pages or screenshots below. Never guess.
Return JSON: {"config": {...}, "evidence": {"<field path>": "where you saw it, quoting the site"}, "questions": ["what the owner must fill in or confirm"]}

config shape:
{
  "name": string,
  "type": schema.org LocalBusiness subtype, e.g. "HairSalon", "Restaurant", "DaySpa",
  "description": one sentence in the business's own words,
  "timezone": IANA zone of the address, e.g. "America/Vancouver",
  "phone": "+1-604-555-0100" style, or null,
  "address": {"street", "city", "region", "postal", "country" (ISO 3166 alpha-2)} or null,
  "hours": {"mon": ["HH:MM", "HH:MM"] 24-hour open and close (closing at midnight is "24:00"; later than that is "24:00" plus a question), or null when closed, ... for all of mon tue wed thu fri sat sun},
  "services": [{"id": lowercase-kebab-case from the name, "name": as written, "minutes": integer duration or null, "price": number without symbol or null, "currency": ISO 4217}],
  "menu": [{"name": as written, "section": menu heading or null, "price": number or null, "currency": ISO 4217}] (food and drink; [] if none),
  "booking": {"provider": lowercase platform name, e.g. "calcom", "calendly", "fresha", "square", "squire", "opentable", or null, "username": account name or slug from the booking link or "", "url": booking page or null}
}
Rules:
- A value the site doesn't state is null, with a question for the owner. Hours that aren't listed are a question, not "closed".
- "From $30" or "$30+" is price 30 with a question confirming it.
- services are what a customer books. Food and drink go in menu, never in services (up to 60 items, most popular first).
- Only if the site shows the place takes reservations (a reservation link, button or text), add one service {"id": "table", "name": "Table reservation", "kind": "table", "minutes": how long a table is held, or null, "price": null, "currency": null, "maxParty": largest party bookable online, or null}. Ask the owner for whichever is null.
- If an item name only makes sense under its menu heading, include the heading (e.g. "Brow shape").
- Booking buttons usually link to another site; find them in "Links to other sites".
- If a cal.com link points at a specific service (cal.com/<username>/<slug>), add "calEventSlug": "<slug>" to that service.`;

function pagesToContent(pages) {
  return pages.flatMap((p, i) => [
    { type: 'text', text: `PAGE ${i + 1}: ${p.url}\nTitle: ${p.title}\n${p.jsonld.length ? `JSON-LD:\n${p.jsonld.join('\n')}\n` : ''}${p.outside.length ? `Links to other sites: ${p.outside.map((l) => `${l.text || '(image)'} → ${l.href}`).join('; ')}\n` : ''}Text:\n${p.text}` },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p.shot}` } },
  ]);
}

async function ask(messages, { baseUrl, model, apiKey }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = (await res.json()).choices[0].message;
  messages.push(msg);
  return JSON.parse(msg.content);
}

// Format errors block installing the config; missing values are for the owner to fill in.
export function validate(c) {
  const errors = [], missing = [];
  const req = (ok, msg) => ok || errors.push(msg);
  req(typeof c?.name === 'string' && c.name.trim(), 'name: required');
  try { new Intl.DateTimeFormat('en', { timeZone: c.timezone }); req(c.timezone, 'timezone: required'); } catch { errors.push(`timezone: "${c.timezone}" is not an IANA zone`); }
  for (const d of DAYS) {
    const h = c.hours?.[d];
    if (h === undefined) errors.push(`hours.${d}: missing (use null if closed)`);
    else if (h !== null) req(Array.isArray(h) && h.length === 2 && /^([01]\d|2[0-3]):[0-5]\d$/.test(h[0]) && /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(h[1]) && h[0] < h[1], `hours.${d}: must be ["HH:MM","HH:MM"], open before close (midnight close is "24:00")`);
  }
  if (!Array.isArray(c.services) || (!c.services.length && !c.menu?.length)) errors.push('services: at least one (or a menu)');
  const ids = new Set();
  (c.services || []).forEach((s, i) => {
    req(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id) && !ids.has(s.id), `services[${i}].id: unique lowercase-kebab-case`);
    ids.add(s.id);
    req(typeof s.name === 'string' && s.name, `services[${i}].name: required`);
    if (s.price != null || s.currency != null) req(/^[A-Z]{3}$/.test(s.currency), `services[${i}].currency: ISO 4217 code`);
    if (s.minutes == null) missing.push(`services[${i}].minutes (${s.name})`);
    else req(Number.isInteger(s.minutes) && s.minutes > 0, `services[${i}].minutes: positive integer`);
    if (s.kind === 'table') { if (s.maxParty == null) missing.push(`services[${i}].maxParty (largest party bookable online)`); else req(Number.isInteger(s.maxParty) && s.maxParty > 0, `services[${i}].maxParty: positive integer`); }
    else if (s.price == null) missing.push(`services[${i}].price (${s.name})`);
    else req(typeof s.price === 'number' && s.price >= 0, `services[${i}].price: number`);
  });
  if (c.menu != null && !Array.isArray(c.menu)) errors.push('menu: a list');
  (Array.isArray(c.menu) ? c.menu : []).forEach((m, i) => {
    req(typeof m.name === 'string' && m.name, `menu[${i}].name: required`);
    if (m.price != null) req(typeof m.price === 'number' && m.price >= 0 && /^[A-Z]{3}$/.test(m.currency), `menu[${i}]: price a number with an ISO 4217 currency`);
  });
  if (!c.phone) missing.push('phone');
  if (!c.address) missing.push('address');
  req(c.booking && typeof c.booking === 'object', 'booking: required (provider null if none)');
  return { errors, missing };
}

// Score a draft against a known-good config, field by field. Booking is skipped: the owner connects it.
export function compare(got, want) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const digits = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
  const out = [];
  const check = (field, g, w, ok = norm(g) === norm(w)) => out.push({ field, ok, got: g, want: w });
  check('name', got.name, want.name, norm(want.name).includes(norm(got.name)) && norm(got.name).length > 3);
  check('timezone', got.timezone, want.timezone);
  check('phone', got.phone, want.phone, digits(got.phone) === digits(want.phone));
  for (const k of ['street', 'city', 'region', 'postal']) check(`address.${k}`, got.address?.[k], want.address[k]);
  for (const d of DAYS) check(`hours.${d}`, JSON.stringify(got.hours?.[d]), JSON.stringify(want.hours[d]));
  // Names are free text ("Classic mani" vs "Classic Manicure"): same name, one inside the other, or same minutes + price.
  const same = (g, w) => norm(g.name) === norm(w.name);
  const near = (g, w) => norm(g.name).includes(norm(w.name)) || norm(w.name).includes(norm(g.name)) || (g.minutes === w.minutes && g.price === w.price);
  const left = [...(got.services || [])];
  for (const w of want.services) {
    const i = left.findIndex((g) => same(g, w)) >= 0 ? left.findIndex((g) => same(g, w)) : left.findIndex((g) => near(g, w));
    const g = i >= 0 ? left.splice(i, 1)[0] : null;
    check(`service ${w.name}`, g?.name, w.name, !!g);
    if (g) for (const k of ['minutes', 'price', 'currency']) check(`service ${w.name}.${k}`, g[k], w[k], g[k] === w[k]);
  }
  for (const g of left) check(`extra service ${g.name}`, g.name, null, false);
  return out;
}

export async function generate(url, { llm = DEFAULT_LLM, log = console.log, onPage = () => {} } = {}) {
  log(`Opening ${url}`);
  const pages = await crawl(url);
  pages.forEach(onPage);
  if (!pages.length) throw new Error(`could not load ${url}`);
  log(`Read ${pages.length} page(s). ${llm.model} is drafting your config…`);
  const messages = [{ role: 'system', content: PROMPT }, { role: 'user', content: pagesToContent(pages) }];
  let draft = await ask(messages, llm);
  let { errors, missing } = validate(draft.config);
  if (errors.length) { // one repair round for format slips
    log(`Fixing format: ${errors.join('; ')}`);
    messages.push({ role: 'user', content: `The config has format errors. Return the full corrected JSON.\n${errors.join('\n')}` });
    draft = await ask(messages, llm);
    ({ errors, missing } = validate(draft.config));
  }
  return { url, model: llm.model, at: new Date().toISOString(), pages: pages.map((p) => p.url), ...draft, errors, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!DEFAULT_LLM.apiKey) throw new Error('Set MODEL_API_KEY in .env (Meta Model API key).');
  const arg = process.argv[2] || 'barbershop';
  const server = /^https?:/.test(arg) ? null : await demoServer({ site: arg });
  const url = server?.url || arg;
  try {
    console.log(`generate: ${DEFAULT_LLM.model} reading ${url}\n`);
    const draft = await generate(url);
    if (server) { // demo sites have a hand-written config to score against
      const truth = await (await fetch(new URL('agentready.json', url))).json();
      draft.score = compare(draft.config, truth);
      for (const c of draft.score.filter((c) => !c.ok)) console.log(`  ✗ ${c.field}: got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)}`);
      console.log(`matches hand-written config: ${draft.score.filter((c) => c.ok).length}/${draft.score.length} fields`);
    }
    console.log(`\nservices: ${draft.config.services.map((s) => `${s.name} ${s.minutes ?? '?'}min ${s.price ?? '?'}${s.calEventSlug ? ` [${s.calEventSlug}]` : ''}`).join(' · ')}`);
    console.log(`booking: ${JSON.stringify(draft.config.booking)}`);
    console.log(`format errors: ${draft.errors.length ? draft.errors.join('; ') : 'none'}`);
    console.log(`owner to fill in: ${draft.missing.join(', ') || 'nothing'}`);
    for (const q of draft.questions || []) console.log(`  ? ${q}`);
    await mkdir('reports', { recursive: true });
    const file = `reports/draft-${new URL(url).hostname}-${draft.at.replace(/[:.]/g, '-')}.json`;
    await writeFile(file, JSON.stringify(draft, null, 2));
    console.log(`→ ${file}`);
  } finally {
    server?.kill();
  }
}
