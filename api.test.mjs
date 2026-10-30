// Runs in mock mode (npm test sets AGENTREADY_MOCK=1), so it never books in the real calendar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from './api/slots.js';
import { POST } from './api/book.js';
import { siteConfig, addSite, local as localTz, spend } from './api/_lib.js';

const config = siteConfig('barbershop');
const local = (when) => localTz(when, config.timezone);

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
  const monday = [...Array(8)].map((_, i) => local(Date.now() + (i + 1) * 864e5)).find((x) => x.day === 'mon');
  const closedStart = new Date(Date.parse(`${monday.date}T18:00:00Z`)).toISOString(); // 2pm Toronto, closed all day
  assert.equal((await book({ ...ok, start: closedStart })).status, 409);
  const after = await (await slots({ service: 'classic-cut', date: d.date })).json();
  assert.ok(!after.slots.some((x) => x.start === s[0].start));
});

test('each site gets its own services and calendar', async () => {
  const salon = siteConfig('salon');
  const d = [...Array(8)].map((_, i) => local(Date.now() + (i + 1) * 864e5)).find((x) => salon.hours[x.day] && config.hours[x.day]);
  assert.equal((await slots({ site: 'salon', service: 'gel-manicure', date: d.date })).status, 200);
  assert.equal((await slots({ service: 'gel-manicure', date: d.date })).status, 400); // barbershop has no gel manicure
  assert.equal((await slots({ site: 'nope', service: 'skin-fade', date: d.date })).status, 404);
  const open = async (q) => (await (await slots({ ...q, date: d.date })).json()).slots.map((x) => x.start);
  const barber = await open({ service: 'skin-fade' });
  const s = (await open({ site: 'salon', service: 'brow-shape' })).findLast((x) => barber.includes(x)); // open at both
  assert.equal((await book({ site: 'salon', service_id: 'brow-shape', start: s, name: 'Ana', email: 'ana@example.com' })).status, 200);
  assert.equal((await book({ service_id: 'skin-fade', start: s, name: 'Ana', email: 'ana@example.com' })).status, 200); // same time, other business
});

test('a table is booked for a party, within the online limit', async () => {
  const site = addSite({ ...config, name: 'Test Diner', menu: [{ name: 'Poutine', price: 14, currency: 'CAD' }],
    services: [{ id: 'table', name: 'Table reservation', kind: 'table', minutes: 90, price: null, currency: null, maxParty: 6 }] });
  const d = tomorrowOpen();
  const { slots: s } = await (await slots({ site, service: 'table', date: d.date })).json();
  const ok = { site, service_id: 'table', start: s[0].start, name: 'Sam Lee', email: 'sam@example.com' };
  assert.equal((await book(ok)).status, 400); // no party size
  assert.equal((await book({ ...ok, party_size: 7 })).status, 400); // over the online limit
  const res = await book({ ...ok, party_size: 4 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).party_size, 4);
});

test('model runs are capped per visitor and per day', () => {
  const req = (xff) => new Request('http://x/', { headers: { 'x-forwarded-for': xff } });
  for (let i = 0; i < 3; i++) assert.equal(spend(req('6.6.6.6, 1.1.1.1'), 'verify'), null);
  assert.match(spend(req('9.9.9.9, 1.1.1.1'), 'verify'), /3 free tests/); // a faked first entry doesn't reset it
  for (let i = 0; i < 12; i++) assert.equal(spend(req(`2.2.2.${i}`), 'verify'), null);
  assert.match(spend(req('8.8.8.8'), 'verify'), /all of today/);
});
