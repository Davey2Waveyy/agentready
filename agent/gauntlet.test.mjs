// The gauntlet's verdict is only as good as these text checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timesIn, claimsBooked, saysClosed, saysPrice, NO_TIMES, tasks } from './gauntlet.mjs';
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
