// validate() gates what can be installed; compare() is how we score the generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, compare } from './generate.mjs';
import truth from '../public/barbershop/agentready.json' with { type: 'json' };

const copy = () => structuredClone(truth);

test('the hand-written config is valid', () => {
  assert.deepEqual(validate(truth), { errors: [], missing: [] });
});

test('format errors block, unknown values go to the owner', () => {
  const c = copy();
  c.timezone = 'Hamilton time';
  c.hours.tue = ['7pm', '10am'];
  delete c.hours.wed;
  c.services[1].id = c.services[0].id;
  c.services[2].price = null;
  c.services[2].currency = null; // no price, so no currency needed
  c.services[3].minutes = null;
  const { errors, missing } = validate(c);
  assert.equal(errors.length, 4, errors.join('\n'));
  assert.deepEqual(missing, ['services[2].price (Beard Trim & Line-up)', 'services[3].minutes (Cut + Beard)']);
});

test('restaurants: menu instead of services, tables need a party limit', () => {
  const c = { ...copy(), services: [{ id: 'table', name: 'Table reservation', kind: 'table', minutes: 90, price: null, currency: null, maxParty: null }],
    menu: [{ name: 'Poutine', section: 'Fries', price: 14, currency: 'CAD' }, { name: 'Shake', price: 8 }] };
  const { errors, missing } = validate(c);
  assert.deepEqual(errors, ['menu[1]: price a number with an ISO 4217 currency']);
  assert.ok(missing.some((m) => m.includes('maxParty')) && !missing.some((m) => m.includes('price')));
  assert.deepEqual(validate({ ...c, services: [], menu: c.menu.slice(0, 1) }).errors, []); // takeout only: a menu is enough
  c.hours.sat = ['11:30', '24:00']; // closes at midnight
  assert.deepEqual(validate(c).errors.filter((e) => e.startsWith('hours')), []);
});

test('compare scores a draft field by field', () => {
  const c = copy();
  assert.ok(compare(c, truth).every((x) => x.ok));
  c.name = 'Fade Street';
  c.phone = '(905) 555-0142';
  c.services[4].price = 35;
  c.hours.mon = ['10:00', '19:00'];
  c.services.push({ id: 'x', name: 'Mystery', minutes: 5, price: 1, currency: 'CAD' });
  const bad = compare(c, truth).filter((x) => !x.ok).map((x) => x.field);
  assert.deepEqual(bad, ['hours.mon', 'service Hot Towel Shave.price', 'extra service Mystery']);
});
