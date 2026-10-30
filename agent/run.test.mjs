// Agent runner tests: real headless Chrome (WebMCPTesting flag) + real agentready.js
// + real api/slots.js, wired via Playwright route interception so no ports needed.
// The model is stubbed (scripted tool calls, no network, no credits).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { waitForTools, turn, systemPrompt } from './run.mjs';
import { GET as slotsGET } from '../api/slots.js';

const ROOT = new URL('..', import.meta.url);
const file = (p) => readFile(new URL(p, ROOT));
const FILES = {
  '/barbershop/': ['public/barbershop/index.html', 'text/html'],
  '/agentready.js': ['public/agentready.js', 'text/javascript'],
  '/barbershop/agentready.json': ['public/barbershop/agentready.json', 'application/json'],
};
const SITE_URL = 'http://localhost/barbershop/'; // localhost = secure context, so modelContext exists

let browser;
before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-features=WebMCPTesting'] });
});
after(async () => { await browser?.close(); });

// Page serving the real site files; `delayConfigMs` holds back agentready.json
// (fetched after load, so page.goto can't absorb the delay) to prove waiting.
async function openTestPage({ delayConfigMs = 0, config } = {}) {
  const page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    try {
      if (u.hostname.includes('fonts.g')) return route.abort('blockedbyclient');
      if (u.pathname === '/api/slots' && route.request().method() === 'GET') {
        const out = await slotsGET(new Request(u, { method: 'GET' }));
        return route.fulfill({ status: out.status, body: Buffer.from(await out.arrayBuffer()), contentType: 'application/json' });
      }
      const hit = FILES[u.pathname];
      if (hit) {
        if (delayConfigMs && u.pathname === '/barbershop/agentready.json') await new Promise((r) => setTimeout(r, delayConfigMs));
        if (config && u.pathname === '/barbershop/agentready.json') return route.fulfill({ json: config });
        return route.fulfill({ status: 200, body: await file(hit[0]), contentType: hit[1] });
      }
      return route.fulfill({ status: 404, body: 'Not found' });
    } catch (e) {
      return route.fulfill({ status: 500, body: String(e?.message || e) });
    }
  });
  await page.goto(SITE_URL);
  return page;
}

const getTools = (page) => page.evaluate(async () =>
  (await document.modelContext.getTools()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));

// Next open date (shop closed Mon) in shop timezone, YYYY-MM-DD.
function nextOpenDate() {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() + i * 864e5);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    if (p.weekday.slice(0, 3).toLowerCase() === 'mon') continue;
    return `${p.year}-${p.month}-${p.day}`;
  }
  throw new Error('no open day found');
}

test('waitForTools waits for delayed registration, then finds 4 tools', async () => {
  const page = await openTestPage({ delayConfigMs: 1500 });
  try {
    const t0 = Date.now();
    await waitForTools(page);
    assert.ok(Date.now() - t0 >= 1400, 'returned before the tools could have registered');
    const tools = await getTools(page);
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ['book_appointment', 'check_availability', 'get_business_info', 'get_services']);
  } finally {
    await page.close();
  }
});

test('waitForTools throws on timeout when no tools register', async () => {
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    await assert.rejects(() => waitForTools(page, 800), /timed out/);
  } finally {
    await page.close();
  }
});

test('turn() loop drives real WebMCP calls with a stub model', async () => {
  const page = await openTestPage();
  try {
    await waitForTools(page);
    const tools = await getTools(page);
    const date = nextOpenDate();
    const script = [
      { tool_calls: [{ id: 'stub-1', type: 'function', function: { name: 'get_services', arguments: '{}' } }] },
      { tool_calls: [{ id: 'stub-2', type: 'function', function: { name: 'check_availability', arguments: JSON.stringify({ service_id: 'skin-fade', date }) } }] },
      { content: 'Stub model done.' },
    ];
    let n = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions')) {
        const step = script[Math.min(n++, script.length - 1)];
        const message = { role: 'assistant', content: step.content ?? null, ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) };
        return { ok: true, json: async () => ({ choices: [{ message }] }) };
      }
      return realFetch(url, init);
    };
    try {
      const messages = [
        { role: 'system', content: systemPrompt(SITE_URL) },
        { role: 'user', content: `book me a skin fade on ${date}` },
      ];
      const seen = [];
      const reply = await turn({ page, tools, messages, log: (e) => seen.push(e) });
      assert.equal(reply, 'Stub model done.');
      assert.deepEqual(seen.filter((e) => e.type === 'call').map((e) => e.name), ['get_services', 'check_availability']);
      const avail = JSON.parse(seen.find((e) => e.type === 'result' && e.name === 'check_availability').result);
      assert.ok(Array.isArray(avail.slots) && avail.slots.length > 0, 'expected real slots back');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await page.close();
  }
});

test('a business booked on another platform gets its link handed over, never a fake booking', async () => {
  const shop = JSON.parse(await file('public/barbershop/agentready.json'));
  const url = 'https://www.opentable.ca/r/test-bistro';
  const page = await openTestPage({ config: { ...shop, booking: { provider: 'opentable', username: 'test-bistro', url } } });
  const calls = [];
  page.on('request', (r) => r.url().includes('/api/') && calls.push(r.url()));
  try {
    await waitForTools(page);
    const out = await page.evaluate(async () => {
      const { tools } = await AgentReady.ready;
      const run = (name, args) => tools.find((t) => t.name === name).execute(args);
      return [await run('check_availability', { service_id: 'skin-fade', date: '2030-01-02' }),
        await run('book_appointment', { service_id: 'skin-fade', start: '2030-01-02T15:00:00Z', name: 'Sam', email: 'sam@example.com' }),
        !!document.querySelector('dialog.agentready-confirm')];
    });
    for (const r of out.slice(0, 2)) assert.deepEqual([r.booked, r.book_at], [false, url]);
    assert.equal(out[2], false, 'no confirm dialog: nothing is booked here');
    assert.deepEqual(calls, [], 'no call to our booking API');
  } finally {
    await page.close();
  }
});
