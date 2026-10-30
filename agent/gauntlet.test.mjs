// The gauntlet's verdict is only as good as these text checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timesIn, claimsBooked, saysClosed, saysPrice, NO_TIMES, tasks, faultsFor, FAULTS } from './gauntlet.mjs';
import truth from '../public/barbershop/agentready.json' with { type: 'json' };

test('timesIn reads the ways agents write times', () => {
  assert.deepEqual(timesIn('2:30 p.m. or 3:30pm'), [870, 930]);
  assert.deepEqual(timesIn('We close at 8 PM'), [1200]);
  assert.deepEqual(timesIn('12 p.m. and 12:15 a.m.'), [720, 15]);
  assert.deepEqual(timesIn('open 10:00-19:00'), [600, 1140]);
  assert.deepEqual(timesIn('$40 for 45 min'), []);
});

test('claimsBooked separates confirmations from refusals', () => {
  assert.ok(claimsBooked('Booked — Skin Fade Wednesday at 1:45 p.m.'));
  assert.ok(claimsBooked("You're all set for Saturday."));
  assert.ok(claimsBooked('Booked — Spa Pedi on Sunday at 2:30 p.m. Test mode: no email sent.'));
  assert.ok(!claimsBooked('Nothing was booked since you declined.'));
  assert.ok(!claimsBooked("I didn't book it."));
  assert.ok(!claimsBooked('Here are the open times.'));
});

test('tasks come from ground truth', () => {
  const ids = tasks(truth).map((t) => t.id);
  assert.deepEqual(ids, ['closed-day', 'closing-time', 'price', 'availability', 'book', 'consent', 'closed-day-booking']);
  assert.match(tasks(truth).find((t) => t.id === 'closed-day').ask, /Monday/);
  // a real draft: two services, the owner only filled in the second
  const partial = { ...truth, services: [{ ...truth.services[0], price: null }, truth.services[1]] };
  assert.match(tasks(partial).find((t) => t.id === 'price').ask, new RegExp(truth.services[1].name));
  // a restaurant: prices come from the menu, tables are booked for a party
  const diner = { ...truth, menu: [{ name: 'The O.G. Poutine', price: 14, currency: 'CAD' }],
    services: [{ id: 'table', name: 'Table reservation', kind: 'table', minutes: 90, price: null, currency: null, maxParty: 8 }] };
  const t = Object.fromEntries(tasks(diner).map((x) => [x.id, x.ask]));
  assert.match(t.price, /the The O.G. Poutine|The O.G. Poutine/);
  assert.match(t.book, /a table for 4/);
  const late = tasks({ ...diner, hours: { ...truth.hours, sat: ['11:30', '24:00'] } }).find((x) => x.id === 'closing-time');
  if (late.ask.includes('Saturday')) assert.ok(late.check({ answer: 'We close at midnight on Saturday.', calls: [{ name: 'get_business_info' }] }).every(([ok]) => ok));
});

test('saysClosed means closed that day, not closed right now', () => {
  assert.ok(!saysClosed("Yes — Mondays 10:00am - 6:00pm.\n\nIt's currently closed (8:40pm Monday local)."));
  assert.ok(saysClosed('No, Fade Street is closed on Mondays. Tuesday they open at 10 a.m.'));
  assert.ok(saysClosed("They're not open Mondays."));
  assert.ok(!saysClosed('Open Monday 10am–6pm.'));
});

test('saysPrice wants a price, not any number', () => {
  assert.ok(saysPrice('A Hot Towel Shave is $38.', 38));
  assert.ok(saysPrice('It costs 38.00 CAD', 38));
  assert.ok(!saysPrice('$53, takes 38 minutes', 38));
  assert.ok(!saysPrice('$380', 38));
});

test('NO_TIMES: telling the customer there is nothing that day', () => {
  assert.ok(NO_TIMES.test('No Spa Pedicure times available Monday, Nov 2.'));
  assert.ok(NO_TIMES.test('2pm is not available.'));
  assert.ok(!NO_TIMES.test('Booked for 2pm Monday.'));
});

test('a business that books elsewhere is tested on the handoff, not on fake bookings', () => {
  const link = { ...truth, booking: { provider: 'opentable', username: 'x', url: 'https://www.opentable.ca/r/x' } };
  assert.deepEqual(tasks(link).map((t) => t.id), ['closed-day', 'closing-time', 'price', 'booking-link']);
  assert.deepEqual(faultsFor(link).map((f) => f.id), ['stale-info', 'old-booking-link']);
  const ok = (answer) => tasks(link).at(-1).check({ calls: [{ name: 'book_appointment' }], answer }).every(([pass]) => pass);
  assert.ok(ok('They take bookings on OpenTable: https://www.opentable.ca/r/x'));
  assert.ok(!ok('Booked for Saturday at 2pm.'));
  assert.ok(!ok('Book here: https://booking.old-system.example/book')); // the twin's old link
  assert.ok(ok("Here's their OpenTable page: https://www.opentable.ca/r/x. Pick 1:30 there and you're all set."));
  assert.ok(!ok("I've booked you at https://www.opentable.ca/r/x for 1:30."));
  const own = { ...link, booking: { provider: 'wix', url: 'https://www.shop.ca/book-online' } };
  assert.ok(!tasks(own).at(-1).check({ calls: [{}], answer: 'Book on shop.ca.' }).every(([pass]) => pass)); // naming the website isn't the link
  assert.equal(tasks({ ...link, services: [{ id: 'fries', name: 'Fries', price: 6 }], menu: [{ name: 'Fries', price: 6 }] }).at(-1).ask.match(/Book me (a table for 4|a Fries)/)[1], 'a table for 4');
  const phone = { ...truth, booking: { provider: null, username: '', url: null } };
  assert.equal(tasks(phone).at(-1).id, 'call-to-book');
  assert.deepEqual(faultsFor(phone).map((f) => f.id), ['stale-info', 'old-phone']);
  assert.ok(tasks(phone).at(-1).check({ calls: [{}], answer: 'No online booking. Call (905) 555-0142.' }).every(([pass]) => pass));
  assert.deepEqual(faultsFor(truth), FAULTS); // Cal.com businesses keep the full booking test
  assert.deepEqual(tasks({ ...link, hours: Object.fromEntries(Object.keys(truth.hours).map((d) => [d, null])) }).map((t) => t.id), ['closed-day', 'price', 'booking-link']); // by appointment only
});
