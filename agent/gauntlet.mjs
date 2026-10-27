// Verification gauntlet: can an AI agent actually get things right on this site?
// Veritas shape: hunt (customer tasks) → null test (broken twin must fail) → mechanical checks → report.
// npm run gauntlet            (starts its own mock-mode server, so nothing is ever really booked)
// npm run gauntlet -- salon   (another demo site; the salon hasn't installed AgentReady, so the test browser adds it)
// npm run gauntlet -- --models muse-spark-1.3   (one model instead of all three skeptics)
// npm run gauntlet -- <url>   (a site already running with AGENTREADY_MOCK=1)
// npm run gauntlet -- --config reports/draft-….json   (verify a generated draft before it goes live)
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { waitForTools, listTools, turn, systemPrompt, DEFAULT_LLM } from './run.mjs';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

// ---- time helpers (business timezone) ----
function localParts(when, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(when)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: p.weekday.slice(0, 3).toLowerCase(), min: +p.hour * 60 + +p.minute };
}
// Next date (after today) that falls on `day`, as YYYY-MM-DD in the business timezone.
function nextDate(day, timeZone) {
  for (let i = 1; i <= 7; i++) {
    const l = localParts(Date.now() + i * 864e5, timeZone);
    if (l.day === day) return l.date;
  }
}
// "Monday, November 2": a bare "Monday" is ambiguous when today is Monday.
const dayLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
export const NO_TIMES = /\bno\b[^.!?\n]*\b(times?|slots?|openings?|availability)\b|\bnot available\b|\bunavailable\b/i;
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// Times written in an answer ("2:30 p.m.", "2pm", "14:30") → minutes since midnight.
export function timesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/gi)) {
    let h = +m[1] % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    out.push(h * 60 + +(m[2] || 0));
  }
  for (const m of String(text).matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s*m)/gi)) out.push(+m[1] * 60 + +m[2]);
  return out;
}
const NEG = /\b(not|n't|no|wasn't|isn't|didn't|declined|cancel\w*|nothing)\b/i;
// Sentences about email or test mode don't count: "Test mode: no email sent" is not a refusal.
export const claimsBooked = (t) => {
  const core = String(t).replace(/[^.!?\n]*\b(e-?mail|test mode)\b[^.!?\n]*/gi, '');
  return /\b(booked|confirmed|all set|you'?re in)\b/i.test(core) && !NEG.test(core);
};
// "Closed" about that day, not about right now: "Yes, Mondays 10-6. It's currently closed" is a yes.
export const saysClosed = (t) => {
  const aboutDay = String(t).replace(/[^.!?\n]*\b(currently|right now|at the moment|now)\b[^.!?\n]*/gi, '');
  return !/^\W*yes\b/i.test(aboutDay) && /\bclosed\b|not open|n['’]t open/i.test(aboutDay);
};
// A price, not any number: "$38", "$38.00", "38 CAD", "38 dollars". Not "38 minutes".
export const saysPrice = (t, n) => new RegExp(`\\$\\s?${n}(\\.00)?\\b|\\b${n}(\\.00)?\\s?(CAD|dollars)`, 'i').test(t);
const fmt12 = (min) => `${(Math.floor(min / 60) + 11) % 12 + 1}${min % 60 ? ':' + String(min % 60).padStart(2, '0') : ''}`;

// ---- tasks: each is a customer request plus a mechanical check against ground truth ----
export function tasks(truth) {
  const tz = truth.timezone;
  const closed = DAYS.find((d) => !truth.hours[d]);
  const open = ['sat', 'sun', 'fri', 'thu', 'wed', 'tue'].filter((d) => truth.hours[d]);
  // Only services the owner gave a duration and price can be tested (real drafts leave gaps for the owner).
  const ready = truth.services.filter((s) => s.minutes && (s.price != null || s.kind === 'table'));
  const paid = ready.filter((s) => s.price > 0); // a free table reservation has no price to get wrong
  const [svcA, svcB, svcC] = [ready[0], ready[2] ?? ready.at(-1), paid[4] ?? paid.at(-1)];
  // Restaurants: the price question is about the menu, and tables are booked for a party of up to 4.
  const dishes = (truth.menu ?? []).filter((m) => m.price > 0);
  const priced = svcC ?? dishes[4] ?? dishes.at(-1);
  const priceTool = svcC ? 'get_services' : 'get_menu';
  const party = (svc) => svc.kind === 'table' ? Math.min(4, svc.maxParty || 4) : null;
  const a = (svc) => svc.kind === 'table' ? `a table for ${party(svc)}` : `a ${svc.name}`;
  const partyOk = (svc, b) => svc.kind !== 'table' || b?.args.party_size === party(svc);
  const called = (run, name) => run.calls.filter((c) => c.name === name);
  const slotsFor = (run, service, date) => called(run, 'check_availability')
    .filter((c) => c.args.service_id === service && c.args.date === date).flatMap((c) => c.result?.slots ?? []);
  const who = 'I\'m Gauntlet Tester, gauntlet@example.com. Go ahead and book it, no need to double-check with me.';

  const list = [];
  if (closed) list.push({
    id: 'closed-day', fact: `closed ${DAY_NAMES[closed]}`,
    ask: `Is ${truth.name} open on ${DAY_NAMES[closed]}?`,
    check: (run) => [
      [called(run, 'get_business_info').length > 0, 'looked up hours with a tool'],
      [saysClosed(run.answer), `said closed on ${DAY_NAMES[closed]}`],
    ],
  });
  const closeDay = open.find((d) => truth.hours[d][1] !== '18:00') ?? open[0]; // twin closes at 18:00 everywhere
  const closeMin = hm(truth.hours[closeDay][1]);
  list.push({
    id: 'closing-time', fact: `${DAY_NAMES[closeDay]} close ${truth.hours[closeDay][1]}`,
    ask: `What time does ${truth.name} close on ${DAY_NAMES[closeDay]}?`,
    check: (run) => [
      [called(run, 'get_business_info').length > 0, 'looked up hours with a tool'],
      [timesIn(run.answer).includes(closeMin) || new RegExp(`\\b${fmt12(closeMin)}\\b`).test(run.answer)
        || (closeMin === 1440 && /\bmidnight\b|\b12(:00)?\s*a\.?\s*m\b/i.test(run.answer)), `said ${truth.hours[closeDay][1]}`],
    ],
  });
  if (priced) list.push({
    id: 'price', fact: `${priced.name} $${priced.price}`,
    ask: `How much is ${svcC ? 'a' : 'the'} ${priced.name}?`,
    check: (run) => [
      [called(run, priceTool).length > 0, 'looked up prices with a tool'],
      [saysPrice(run.answer, priced.price), `said $${priced.price}`],
    ],
  });
  const dayA = open[0], dateA = nextDate(dayA, tz);
  list.push({
    id: 'availability', fact: `${svcA.name} slots ${dateA} after 2pm`,
    ask: svcA.kind === 'table' ? `What times do you have for ${a(svcA)} on ${dayLabel(dateA)} after 2pm?` : `What ${svcA.name} times do you have on ${dayLabel(dateA)} after 2pm?`,
    check: (run) => {
      const real = slotsFor(run, svcA.id, dateA).map((s) => localParts(s.start, tz).min).filter((m) => m >= 840);
      const said = timesIn(run.answer.replace(/\b(after|before)\s+\d{1,2}(:\d{2})?\s*([ap]\.?\s*m\b\.?)?/gi, '')).filter((m) => m >= 840);
      return [
        [real.length > 0, `checked live availability for ${dateA}`],
        [said.length > 0, 'offered at least one time'],
        [said.every((m) => real.includes(m)), 'every time offered is really open'],
      ];
    },
  });
  const dayB = open[1] ?? open[0], dateB = nextDate(dayB, tz);
  list.push({
    id: 'book', human: 'confirm', fact: `${svcB.name} booked ${dateB}`,
    ask: `Book me ${a(svcB)} on ${dayLabel(dateB)}, the earliest time after 1pm. ${who}`,
    check: (run, after) => {
      const b = called(run, 'book_appointment').at(-1);
      const offered = slotsFor(run, svcB.id, dateB).map((s) => s.start);
      return [
        [!!b && offered.includes(b.args.start) && localParts(b.args.start, tz).min >= 780, 'booked a real open slot after 1pm'],
        ...(svcB.kind === 'table' ? [[partyOk(svcB, b), `booked for ${party(svcB)} people`]] : []),
        [run.dialogs.length > 0, 'customer saw the confirm dialog'],
        [b?.result?.booked === true, 'booking went through'],
        [claimsBooked(run.answer), 'told the customer it is booked'],
        [!!b && !after.slots(svcB.id, dateB).includes(b.args.start), 'slot is gone from live availability'],
      ];
    },
  });
  const dayC = open[2] ?? open[0], dateC = nextDate(dayC, tz);
  list.push({
    id: 'consent', human: 'decline', fact: `decline ${svcA.name} ${dateC}`,
    ask: `Book me ${a(svcA)} on ${dayLabel(dateC)}, the earliest time after 1pm. ${who}`,
    check: (run, after) => {
      const b = called(run, 'book_appointment').at(-1);
      return [
        [run.dialogs.length > 0, 'customer saw the confirm dialog'],
        [!!b && b.result?.booked === false, 'nothing booked after the customer declined'],
        [!claimsBooked(run.answer), 'did not claim it was booked'],
        [!b || after.slots(svcA.id, dateC).includes(b.args.start), 'slot still open'],
      ];
    },
  });
  if (closed) list.push({
    id: 'closed-day-booking', human: 'confirm', fact: `no booking on ${DAY_NAMES[closed]}`,
    ask: `Book me ${a(svcB)} on ${dayLabel(nextDate(closed, tz))} at 2pm. ${who}`,
    check: (run) => [
      // Booking another day the customer approved in the dialog is fine; a booking on the closed day is not.
      [!called(run, 'book_appointment').some((c) => c.result?.booked && localParts(c.args.start, tz).day === closed), `did not book on ${DAY_NAMES[closed]}`],
      [saysClosed(run.answer) || NO_TIMES.test(run.answer), 'told the customer they are closed'],
    ],
  });
  return list;
}

// ---- broken twin: the same site with real-world faults injected. If the gauntlet passes it, the gauntlet is worthless. ----
export const FAULTS = [
  { id: 'stale-info', what: 'site serves outdated prices and hours', caughtBy: ['closed-day', 'closing-time', 'price'] },
  { id: 'booking-down', what: 'booking backend returns errors', caughtBy: ['book'] },
  { id: 'no-consent-gate', what: 'confirm dialog auto-approves without the customer', caughtBy: ['consent'] },
];
async function breakTwin(page, truth) {
  await page.route(CONFIG, (route) => {
    const c = structuredClone(truth);
    for (const s of [...c.services, ...(c.menu ?? [])]) if (s.price > 0) s.price += 15;
    for (const d of DAYS) c.hours[d] = c.hours[d] ? [c.hours[d][0], '18:00'] : ['10:00', '18:00'];
    return route.fulfill({ json: c, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(/\/api\/book$/, (route) => route.fulfill({ status: 500, json: { error: 'internal_error' }, headers: { 'access-control-allow-origin': '*' } }));
  await page.addInitScript(() => {
    // Open and instantly approve. close() is a no-op on a never-opened dialog, hence show() first.
    HTMLDialogElement.prototype.showModal = function () { this.show(); this.close('yes'); };
  });
}

// Verify before going live: a site that hasn't installed AgentReady gets the script tag added in the test browser only.
// With `site`, the tag points at AgentReady's host (as the real install would), which the test browser routes to `api`.
const HOST = 'https://agentready.test';
function installAgentReady({ host, site }) {
  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('script[src$="agentready.js"]')) return;
    const s = document.createElement('script');
    if (site) { s.dataset.site = site; s.src = `${host}/agentready.js`; } else { Object.assign(s.dataset, { config: 'agentready.json', api: '/api' }); s.src = '/agentready.js'; }
    document.head.append(s);
  });
}

// Plays the customer: watches for AgentReady's confirm dialog and clicks Confirm or Cancel.
function actAsHuman(page, mode, dialogs) {
  (async () => {
    for (;;) {
      const btn = await page.waitForSelector('dialog.agentready-confirm[open]', { timeout: 0 }).catch(() => null);
      if (!btn) return;
      dialogs.push((await btn.textContent()).replace(/\s+/g, ' ').trim());
      await page.click(`dialog.agentready-confirm button[value=${mode === 'confirm' ? 'yes' : 'no'}]`).catch(() => {});
      await page.waitForSelector('dialog.agentready-confirm', { state: 'detached' }).catch(() => {});
    }
  })();
}

const CONFIG = /\/agentready\.json(\?|$)|\/api\/config\?/; // a self-hosted config file, or the host's config endpoint
// A draft under verification: the test browser gets the draft config, and API calls name the draft's site id.
async function serveDraft(page, config, site) {
  await page.route(CONFIG, (r) => r.fulfill({ json: config, headers: { 'access-control-allow-origin': '*' } }));
  // A site with its own tag (no data-site) calls its own /api: name the draft. Calls to the host already carry it.
  const own = (r) => !r.request().url().startsWith(HOST);
  await page.route(/\/api\/slots\?/, (r) => { if (!own(r)) return r.fallback(); const u = new URL(r.request().url()); u.searchParams.set('site', site); return r.continue({ url: u.href }); });
  await page.route(/\/api\/book$/, (r) => own(r) ? r.continue({ postData: JSON.stringify({ ...r.request().postDataJSON(), site }) }) : r.fallback());
}

async function runTask(browser, url, task, { twin, truth, site, draft, api, llm }) {
  const page = await browser.newPage();
  // The AgentReady host, as seen from the test browser: our own server (an installed site's tag points there).
  await page.route(`${HOST}/**`, async (r) => r.fulfill({ response: await r.fetch({ url: r.request().url().replace(HOST, api) }) }));
  if (draft) await serveDraft(page, truth, site);
  if (twin) await breakTwin(page, truth); // registered last, so its routes win
  await page.addInitScript(installAgentReady, { host: HOST, site: draft ? site : null });
  await page.goto(url);
  await waitForTools(page);
  const run = { calls: [], dialogs: [], answer: '' };
  actAsHuman(page, task.human ?? 'decline', run.dialogs);
  const messages = [{ role: 'system', content: systemPrompt(url) }, { role: 'user', content: task.ask }];
  try {
    run.answer = await turn({
      page, tools: await listTools(page), messages, llm,
      log: (e) => {
        if (e.type === 'call') run.calls.push({ name: e.name, args: e.args });
        else { try { run.calls.at(-1).result = JSON.parse(e.result); } catch { run.calls.at(-1).result = e.result; } }
      },
    });
  } catch (e) {
    run.answer = `ERROR: ${e.message}`;
  }
  // Live availability after the run, straight from the server (not through the possibly-broken page).
  const cache = {};
  for (const c of run.calls.filter((c) => c.name === 'check_availability')) {
    const k = `${c.args.service_id}|${c.args.date}`;
    cache[k] ??= (await (await fetch(`${api}/api/slots?${new URLSearchParams({ site, service: c.args.service_id, date: c.args.date })}`)).json()).slots?.map((s) => s.start) ?? [];
  }
  const after = { slots: (s, d) => cache[`${s}|${d}`] ?? [] };
  await page.close();
  const checks = task.check(run, after).map(([ok, label]) => ({ ok: !!ok, label }));
  return { id: task.id, pass: checks.every((c) => c.ok), checks, answer: run.answer, calls: run.calls.map((c) => c.name), dialogs: run.dialogs.length };
}

// `config` + `site`: verify a draft (registered with addSite) instead of the config the site serves.
// `api`: where AgentReady's API runs, from this process (default: the site's own origin, like the demos).
export async function gauntlet(url, { llm = DEFAULT_LLM, log = console.log, config, site, api = new URL(url).origin, onTasks = () => {}, onRunning = () => {}, onResult = () => {} } = {}) {
  const configUrl = new URL('agentready.json', url); // ponytail: assumes config sits next to the page
  const truth = config ?? await (await fetch(configUrl)).json(); // ground truth = the owner-approved config
  site ??= configUrl.pathname.split('/').at(-2); // same id agentready.js sends
  const list = tasks(truth);
  onTasks(list);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-features=WebMCPTesting'] });
  const report = { url, model: llm.model, at: new Date().toISOString(), site: [], twin: [] };
  try {
    for (const [side, twin] of [['site', false], ['twin', true]]) {
      for (const task of list) {
        onRunning(side, task.id);
        const r = await runTask(browser, url, task, { twin, truth, site, draft: !!config, api, llm });
        onResult(side, r);
        report[side].push(r);
        log(`${side === 'site' ? 'site' : 'twin'}  ${r.pass ? 'PASS' : 'FAIL'}  ${task.id.padEnd(19)} ${r.checks.filter((c) => !c.ok).map((c) => '✗ ' + c.label).join('; ')}`);
      }
    }
  } finally {
    await browser.close();
  }
  const failedOnTwin = new Set(report.twin.filter((r) => !r.pass).map((r) => r.id));
  report.faults = FAULTS.map((f) => ({ ...f, caught: f.caughtBy.some((id) => failedOnTwin.has(id)) }));
  report.verdict = {
    sitePassed: report.site.every((r) => r.pass),
    twinCaught: `${report.faults.filter((f) => f.caught).length}/${FAULTS.length} faults`,
    // The null test: a gauntlet that can't tell the broken twin from the real site proves nothing.
    gauntletHasTeeth: report.faults.every((f) => f.caught),
  };
  report.verdict.verified = report.verdict.sitePassed && report.verdict.gauntletHasTeeth;
  return report;
}

// Skeptics: three different Meta models. Verified only if every one gets the site right and catches every twin fault.
export const SKEPTICS = ['muse-spark-1.3', 'muse-wonder-1.0', 'muse-spark-1.2'];

// The app server in this process, mock mode, so nothing is ever really booked.
export async function demoServer({ site = 'barbershop', port = 3200 } = {}) {
  process.env.AGENTREADY_MOCK = '1';
  const { server } = await import('../dev.mjs');
  await new Promise((ok) => server.listen(port, ok));
  return { url: `http://localhost:${port}/${site}/`, kill: () => { server.closeAllConnections(); server.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!DEFAULT_LLM.apiKey) throw new Error('Set MODEL_API_KEY in .env (Meta Model API key).');
  const args = process.argv.slice(2);
  const configAt = args.indexOf('--config');
  const draftFile = configAt >= 0 ? args.splice(configAt, 2)[1] : null;
  const modelsAt = args.indexOf('--models');
  const models = modelsAt >= 0 ? args.splice(modelsAt, 2)[1].split(',') : SKEPTICS;
  // A generated draft (reports/draft-*.json) or a plain config, verified on the demo site it came from.
  const draft = draftFile && JSON.parse(await readFile(draftFile, 'utf8'));
  const config = draft && (draft.config ?? draft);
  const arg = args[0] || draft?.url?.match(/localhost:\d+\/([^/]+)\//)?.[1] || 'barbershop';
  if (config && /^https?:/.test(arg)) throw new Error('--config verifies on a demo site (barbershop, salon); use the app for other URLs');
  const server = /^https?:/.test(arg) ? null : await demoServer({ site: arg });
  const url = server?.url || arg;
  const site = config && (await import('../api/_lib.js')).addSite(config);
  try {
    console.log(`gauntlet: ${models.join(', ')} on ${url}${draftFile ? ` with ${draftFile}` : ''}`);
    // ponytail: skeptics run one after another; the mock calendar is shared, so parallel runs would race for the same slot
    const runs = [];
    for (const model of models) {
      console.log(`\n— ${model}`);
      runs.push(await gauntlet(url, { llm: { ...DEFAULT_LLM, model }, config, site }));
    }
    const report = { url, at: runs[0].at, verdict: { verified: runs.every((r) => r.verdict.verified), skeptics: runs.map((r) => ({ model: r.model, ...r.verdict })) }, runs };
    await mkdir('reports', { recursive: true });
    const file = `reports/gauntlet-${report.at.replace(/[:.]/g, '-')}.json`;
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log('');
    for (const v of report.verdict.skeptics) console.log(`${v.model.padEnd(18)} site passed: ${v.sitePassed} · twin caught: ${v.twinCaught}`);
    console.log(report.verdict.verified ? `VERIFIED agent-ready by ${models.length} skeptic(s)` : 'NOT verified', `→ ${file}`);
  } finally {
    server?.kill();
  }
}
