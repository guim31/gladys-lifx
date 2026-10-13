// -----------------------------------------------------------------------------
// Capabilities from the LIFX product registry: the features of each product,
// changed by its firmware upgrades.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesOf } from '../src/lifx/products.js';
import { PRODUCTS } from '../src/lifx/products-data.js';

const caps = (product, major, minor) => capabilitiesOf({ vendor: 1, product }, { major, minor });

test('the registry has one entry per product id, each with a name', () => {
  const ids = PRODUCTS.map((product) => product.pid);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(PRODUCTS.length >= 170);
  assert.ok(PRODUCTS.every((product) => typeof product.name === 'string' && product.name));
});

test('a firmware upgrade widens the white range (LIFX A19, product 27)', () => {
  assert.deepEqual(caps(27, 2, 79).kelvin, { min: 2500, max: 9000 });
  assert.deepEqual(caps(27, 2, 80).kelvin, { min: 1500, max: 9000 });
  assert.deepEqual(caps(27, 3, 0).kelvin, { min: 1500, max: 9000 });
  assert.equal(caps(27, 2, 80).color, true);
  assert.equal(caps(27, 2, 80).product, 'LIFX (A19)');
});

test('strips: the extended zone messages come with firmware 2.77 (LIFX Z, product 32)', () => {
  assert.equal(caps(32, 2, 76).multizone, true);
  assert.equal(caps(32, 2, 76).extendedMultizone, false);
  assert.equal(caps(32, 2, 77).extendedMultizone, true);
});

test('white bulbs: a range gives a temperature, a fixed white none', () => {
  assert.equal(caps(50, 3, 70).temperature, true);
  assert.equal(caps(50, 3, 70).color, false);
  assert.equal(caps(51, 3, 70).temperature, false, 'Mini W, 2700 K');
  assert.equal(caps(85, 3, 70).temperature, false, 'Filament Amber, 2000 K');
});

test('infrared, matrices', () => {
  assert.equal(caps(109, 3, 90).infrared, true);
  assert.equal(caps(55, 3, 70).matrix, true);
  assert.equal(caps(57, 3, 70).matrix, true);
  assert.equal(caps(27, 2, 80).matrix, false);
});

test('a LIFX Switch is not a light; an unknown product is handled as a colour light', () => {
  assert.equal(caps(70, 3, 90), null);
  const unknown = caps(999, 4, 0);
  assert.equal(unknown.known, false);
  assert.equal(unknown.product, null);
  assert.equal(unknown.color, true);
  assert.deepEqual(unknown.kelvin, { min: 1500, max: 9000 });
  assert.equal(capabilitiesOf({ vendor: 2, product: 27 }, { major: 1, minor: 0 }).known, false);
});
