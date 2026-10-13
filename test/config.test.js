import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHosts } from '../src/config.js';

test('addresses: IPv4 only, separated by anything, without duplicates', () => {
  assert.deepEqual(parseHosts('192.0.2.10, 192.0.2.11;192.0.2.10\n198.51.100.7'), {
    hosts: ['192.0.2.10', '192.0.2.11', '198.51.100.7'],
    invalid: [],
  });
  assert.deepEqual(parseHosts('192.0.2.010 lifx.local 192.0.2.300 http://192.0.2.1'), {
    hosts: ['192.0.2.10'],
    invalid: ['lifx.local', '192.0.2.300', 'http://192.0.2.1'],
  });
  assert.deepEqual(parseHosts(undefined), { hosts: [], invalid: [] });
});

test('defaults: no address, every 15 s, no fade, French names', () => {
  assert.deepEqual(normalizeConfig(), {
    hosts: [],
    invalidHosts: [],
    pollSeconds: 15,
    transitionMs: 0,
    language: 'fr',
  });
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('an unknown interval, fade or language falls back to the defaults', () => {
  const config = normalizeConfig({
    poll_interval: '7',
    transition: '42',
    language: 'it',
    hosts: 42,
  });
  assert.equal(config.pollSeconds, 15);
  assert.equal(config.transitionMs, 0);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: 60 }).pollSeconds, 60);
  assert.equal(normalizeConfig({ transition: '2000' }).transitionMs, 2000);
  assert.equal(normalizeConfig(null).language, 'fr');
});
