// Verification gauntlet: can an AI agent actually get things right on this site?
// Veritas shape: hunt (customer tasks) → null test (broken twin must fail) → mechanical checks → report.
// npm run gauntlet            (starts its own mock-mode server, so nothing is ever really booked)
// npm run gauntlet -- <url>   (a site already running with AGENTREADY_MOCK=1)
// npm run gauntlet -- --config reports/draft-….json   (verify a generated draft before it goes live)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
export const claimsBooked = (t) => /\b(booked|confirmed|all set|you'?re in)\b/i.test(t) && !NEG.test(t);
const fmt12 = (min) => `${(Math.floor(min / 60) + 11) % 12 + 1}${min % 60 ? ':' + String(min % 60).padStart(2, '0') : ''}`;

// ---- tasks: each is a customer request plus a mechanical check against ground truth ----
export function tasks(truth) {
  const tz = truth.timezone;
  const closed = DAYS.find((d) => !truth.hours[d]);
  const open = ['sat', 'sun', 'fri', 'thu', 'wed', 'tue'].filter((d) => truth.hours[d]);
  const [svcA, svcB, svcC] = [truth.services[0], truth.services[2], truth.services[4]];
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
      [/\bclosed\b|not open|n['’]t open/i.test(run.answer), `said closed on ${DAY_NAMES[closed]}`],
    ],
  });
  const closeDay = open.find((d) => truth.hours[d][1] !== '18:00') ?? open[0]; // twin closes at 18:00 everywhere
  const closeMin = hm(truth.hours[closeDay][1]);
  list.push({
    id: 'closing-time', fact: `${DAY_NAMES[closeDay]} close ${truth.hours[closeDay][1]}`,
    ask: `What time does ${truth.name} close on ${DAY_NAMES[closeDay]}?`,
    check: (run) => [
      [called(run, 'get_business_info').length > 0, 'looked up hours with a tool'],
      [timesIn(run.answer).includes(closeMin) || new RegExp(`\\b${fmt12(closeMin)}\\b`).test(run.answer), `said ${truth.hours[closeDay][1]}`],
    ],
  });
  list.push({
    id: 'price', fact: `${svcC.name} $${svcC.price}`,
    ask: `How much is a ${svcC.name}?`,
    check: (run) => [
      [called(run, 'get_services').length > 0, 'looked up prices with a tool'],
      [new RegExp(`\\$?\\b${svcC.price}(\\.00)?\\b`).test(run.answer), `said $${svcC.price}`],
    ],
  });
  const dayA = open[0], dateA = nextDate(dayA, tz);
  list.push({
    id: 'availability', fact: `${svcA.name} slots ${dateA} after 2pm`,
    ask: `What ${svcA.name} times do you have on ${DAY_NAMES[dayA]} after 2pm?`,
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
    ask: `Book me a ${svcB.name} on ${DAY_NAMES[dayB]}, the earliest time after 1pm. ${who}`,
    check: (run, after) => {
      const b = called(run, 'book_appointment').at(-1);
      const offered = slotsFor(run, svcB.id, dateB).map((s) => s.start);
      return [
        [!!b && offered.includes(b.args.start) && localParts(b.args.start, tz).min >= 780, 'booked a real open slot after 1pm'],
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
    ask: `Book me a ${svcA.name} on ${DAY_NAMES[dayC]}, the earliest time after 1pm. ${who}`,
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
    ask: `Book me a ${svcB.name} on ${DAY_NAMES[closed]} at 2pm. ${who}`,
    check: (run) => [
      [!called(run, 'book_appointment').some((c) => c.result?.booked), `did not book on ${DAY_NAMES[closed]}`],
      [/\bclosed\b|not open|n['’]t open|no (open|available)/i.test(run.answer), 'told the customer they are closed'],
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
async function breakTwin(page, configUrl) {
  await page.route(configUrl, async (route) => {
    const c = await (await route.fetch()).json();
    for (const s of c.services) s.price += 15;
    for (const d of DAYS) c.hours[d] = c.hours[d] ? [c.hours[d][0], '18:00'] : ['10:00', '18:00'];
    await route.fulfill({ json: c });
  });
  await page.route('**/api/book', (route) => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
  await page.addInitScript(() => {
    // Open and instantly approve. close() is a no-op on a never-opened dialog, hence show() first.
    HTMLDialogElement.prototype.showModal = function () { this.show(); this.close('yes'); };
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

async function runTask(browser, url, task, { twin, configUrl, llm }) {
  const page = await browser.newPage();
  if (twin) await breakTwin(page, configUrl);
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
  const origin = new URL(url).origin;
  const cache = {};
  for (const c of run.calls.filter((c) => c.name === 'check_availability')) {
    const k = `${c.args.service_id}|${c.args.date}`;
    cache[k] ??= (await (await fetch(`${origin}/api/slots?service=${c.args.service_id}&date=${c.args.date}`)).json()).slots?.map((s) => s.start) ?? [];
  }
  const after = { slots: (s, d) => cache[`${s}|${d}`] ?? [] };
  await page.close();
  const checks = task.check(run, after).map(([ok, label]) => ({ ok: !!ok, label }));
  return { id: task.id, pass: checks.every((c) => c.ok), checks, answer: run.answer, calls: run.calls.map((c) => c.name), dialogs: run.dialogs.length };
}

export async function gauntlet(url, { llm = DEFAULT_LLM, log = console.log } = {}) {
  const configUrl = new URL('agentready.json', url).href; // ponytail: assumes config sits next to the page
  const truth = await (await fetch(configUrl)).json(); // ground truth = the owner-approved config
  const list = tasks(truth);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-features=WebMCPTesting'] });
  const report = { url, model: llm.model, at: new Date().toISOString(), site: [], twin: [] };
  try {
    for (const [side, twin] of [['site', false], ['twin', true]]) {
      for (const task of list) {
        const r = await runTask(browser, url, task, { twin, configUrl, llm });
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

// Own server in mock mode, so nothing is ever really booked. `config`: serve and verify that config instead of the demo's.
export async function demoServer({ config, port = 3200 } = {}) {
  const env = { ...process.env, PORT: String(port), AGENTREADY_MOCK: '1' };
  if (config) env.AGENTREADY_CONFIG = config;
  const proc = spawn(process.execPath, ['dev.mjs'], { env, stdio: 'ignore' });
  const url = `http://localhost:${port}/barbershop/`;
  for (let i = 0; i < 50 && !(await fetch(url).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
  return { url, kill: () => proc.kill() };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!DEFAULT_LLM.apiKey) throw new Error('Set MODEL_API_KEY in .env (Meta Model API key).');
  const args = process.argv.slice(2);
  const configAt = args.indexOf('--config');
  const draft = configAt >= 0 ? args.splice(configAt, 2)[1] : null;
  let config;
  if (draft) { // a generated draft (reports/draft-*.json) or a plain config, verified on the demo site
    const j = JSON.parse(await readFile(draft, 'utf8'));
    config = resolve('reports/.verify-config.json');
    await mkdir('reports', { recursive: true });
    await writeFile(config, JSON.stringify(j.config ?? j));
  }
  const server = args[0] ? null : await demoServer({ config });
  const url = args[0] || server.url;
  try {
    console.log(`gauntlet: ${DEFAULT_LLM.model} on ${url}${draft ? ` with ${draft}` : ''}\n`);
    const report = await gauntlet(url);
    await mkdir('reports', { recursive: true });
    const file = `reports/gauntlet-${report.at.replace(/[:.]/g, '-')}.json`;
    await writeFile(file, JSON.stringify(report, null, 2));
    const v = report.verdict;
    console.log(`\nsite passed: ${v.sitePassed} · twin caught: ${v.twinCaught} · gauntlet has teeth: ${v.gauntletHasTeeth}`);
    console.log(v.verified ? 'VERIFIED agent-ready' : 'NOT verified', `→ ${file}`);
  } finally {
    server?.kill();
  }
}
