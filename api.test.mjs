// Runs in mock mode (npm test sets AGENTREADY_MOCK=1), so it never books in the real calendar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './api/slots.js';
import { POST } from './api/book.js';
import { config, local } from './api/_lib.js';

const tomorrowOpen = () => {
  for (let i = 1; i < 8; i++) {
    const d = local(Date.now() + i * 864e5);
    if (config.hours[d.day]) return d;
  }
};
const slots = (q) => GET(new Request(`http://x/api/slots?${new URLSearchParams(q)}`));
const book = (b) => POST(new Request('http://x/api/book', { method: 'POST', body: JSON.stringify(b) }));

test('slots fall inside opening hours on the requested local date', async () => {
  const d = tomorrowOpen();
  const res = await slots({ service: 'skin-fade', date: d.date });
  assert.equal(res.status, 200);
  const { slots: s } = await res.json();
  assert.ok(s.length > 0);
  const [open, close] = config.hours[d.day];
  for (const { start } of s) {
    const l = local(new Date(start));
    assert.equal(l.date, d.date);
    assert.ok(l.hm >= open && local(Date.parse(start) + 45 * 6e4).hm <= close, start);
  }
});

test('closed day has no slots; bad input rejected', async () => {
  const monday = [...Array(8)].map((_, i) => local(Date.now() + i * 864e5)).find((d) => d.day === 'mon');
  assert.deepEqual((await (await slots({ service: 'skin-fade', date: monday.date })).json()).slots, []);
  assert.equal((await slots({ service: 'nope', date: monday.date })).status, 400);
  assert.equal((await slots({ service: 'skin-fade', date: 'tomorrow' })).status, 400);
});

test('book validates, books once, refuses double booking', async () => {
  const d = tomorrowOpen();
  const { slots: s } = await (await slots({ service: 'classic-cut', date: d.date })).json();
  const ok = { service_id: 'classic-cut', start: s[0].start, name: 'Sam Lee', email: 'sam@example.com' };
  assert.equal((await book({ ...ok, email: 'nope' })).status, 400);
  assert.equal((await book({ ...ok, start: '2020-01-01T10:00:00Z' })).status, 400);
  assert.equal((await book({ ...ok, service_id: 'x' })).status, 400);
  const first = await book(ok);
  assert.equal(first.status, 200);
  assert.match((await first.json()).uid, /^mock-/);
  assert.equal((await book(ok)).status, 409);
  const after = await (await slots({ service: 'classic-cut', date: d.date })).json();
  assert.ok(!after.slots.some((x) => x.start === s[0].start));
});
