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
  c.services[3].minutes = null;
  const { errors, missing } = validate(c);
  assert.equal(errors.length, 4, errors.join('\n'));
  assert.deepEqual(missing, ['services[2].price (Beard Trim & Line-up)', 'services[3].minutes (Cut + Beard)']);
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
