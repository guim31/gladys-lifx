// -----------------------------------------------------------------------------
// What the container writes at the default level (info): the life of the
// lights and of Gladys, never one line per reading, a repeated failure once,
// no secret. Also: the hub reads the lights by its own timer, without onPoll.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS } from '../src/devices.js';
import { FAKE_TYPES } from './helpers/fakeLifx.js';
import { COLOR_BULB, Z_STRIP, createAll, createWorld, featureId } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/** Everything written on stdout and stderr while `fn` runs, at `level`. */
async function capture(t, fn, level = 'info') {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = previous;
  }
  return lines;
}

async function createdWorld(t, options) {
  const world = await createWorld(options);
  t.after(() => world.stop());
  await createAll(world);
  return world;
}

const brightness = (world) =>
  world.fake.lastState(featureId(world.gladys, world.light.serial, FEATURE_KEYS.BRIGHTNESS));

test('logs: normal readings, with changes, and commands write nothing at the info level', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB, Z_STRIP] });
  const bulb = world.light;
  const device = world.fake.discoveredDevices[0];
  const power = device.features.find((feature) => feature.external_id.endsWith(':power'));
  const lines = await capture(t, async () => {
    for (const level of [10000, 20000, 30000, 30000]) {
      bulb.color.brightness = level;
      await world.poll();
    }
    await world.fake.setValue(device, power, 0);
    await world.hub.rediscover();
    await world.hub.idle();
  });
  assert.equal(brightness(world), 46);
  assert.deepEqual(lines, []);
});

test('logs: Gladys refusing the states at every reading is said once, and its return once', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  const refusal = t.mock.method(world.gladys, 'publishChangedStates', async () => {
    throw new GladysApiError(503, 'SERVICE_UNAVAILABLE', 'Gladys is restarting');
  });
  const failing = await capture(t, async () => {
    for (const level of [10000, 20000, 30000, 40000]) {
      bulb.color.brightness = level;
      await world.poll();
    }
    await world.hub.idle();
  });
  assert.equal(failing.length, 1, failing.join('\n'));
  assert.match(failing[0], /\[WARN\].*Gladys does not take the LIFX updates: Gladys is restarting/);

  refusal.mock.restore();
  const back = await capture(t, async () => {
    await world.poll();
    await world.poll();
  });
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*Gladys takes the LIFX updates again/);
  assert.equal(brightness(world), 61);
});

test('logs: a light answering garbage is said once, and its return once', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  const handle = bulb.handle.bind(bulb);
  // A LightState cut short: the reading cannot be decoded.
  bulb.handle = (message) =>
    handle(message).map((reply) =>
      reply.readUInt16LE(32) === FAKE_TYPES.LIGHT_STATE ? fixSize(reply.subarray(0, 50)) : reply,
    );
  const failing = await capture(t, async () => {
    for (let poll = 0; poll < 4; poll += 1) {
      await world.poll();
    }
  });
  assert.equal(failing.length, 1, failing.join('\n'));
  assert.match(failing[0], /\[WARN\].*Cannot read 127\.0\.0\.1/);

  bulb.handle = handle;
  const back = await capture(t, async () => {
    await world.poll();
    await world.poll();
  });
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*LIFX "Salon" reads again/);
});

test('logs: a light that stops answering is said once, and its return once', async (t) => {
  const world = await createdWorld(t);
  world.light.online = false;
  const lost = await capture(t, async () => {
    for (let poll = 0; poll < 5; poll += 1) {
      await world.poll();
    }
  });
  assert.equal(lost.length, 1, lost.join('\n'));
  assert.match(lost[0], /\[INFO\].*LIFX "Salon" no longer answers/);
  world.light.online = true;
  const back = await capture(t, async () => {
    await world.poll();
    await world.poll();
  });
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*LIFX "Salon" answers again/);
});

test('logs: a core without the active scan is said once; a busy scan is not a warning', async (t) => {
  const world = await createdWorld(t);
  const scan = t.mock.method(world.gladys, 'scanNetwork', async () => {
    throw new GladysApiError(403, 'FORBIDDEN', 'network_discovery not declared');
  });
  const refused = await capture(t, async () => {
    for (let round = 0; round < 3; round += 1) {
      await world.hub.track(world.hub.rediscover());
    }
  });
  assert.equal(refused.length, 1, refused.join('\n'));
  assert.match(refused[0], /\[WARN\].*LIFX discovery through Gladys failed/);

  scan.mock.mockImplementation(async () => {
    throw new GladysApiError(429, 'TOO_MANY_REQUESTS', 'A scan ran less than 10 s ago');
  });
  const busy = await capture(t, async () => {
    await world.hub.track(world.hub.rediscover());
  });
  assert.deepEqual(busy, []);
  assert.equal(world.hub.summary().scan, 'busy');
});

test('logs: a bug in a background task is logged with its stack, not hidden', async (t) => {
  const world = await createdWorld(t);
  t.mock.method(world.hub, 'publishTransports', async () => {
    throw new RangeError('a bug');
  });
  const lines = await capture(t, async () => {
    await world.hub.track(world.hub.rediscover());
  });
  const text = lines.join('\n');
  assert.match(text, /\[ERROR\].*Background task failed/);
  assert.match(text, /RangeError: a bug\n\s+at /);
});

test('logs: one line per scene action of the user', async (t) => {
  const world = await createdWorld(t);
  const lines = await capture(t, async () => {
    await world.fake.sceneAction('pulse', {
      device: world.fake.discoveredDevices[0].external_id,
      period: '250',
      cycles: 1,
    });
  });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[INFO\].*LIFX "Salon": blink red, 1 × 250 ms/);
});

test('logs: no secret to leak — the configuration has none, debug lines show no credential', async (t) => {
  const kinds = new Set(
    [...manifest.config_schema, ...manifest.actions.flatMap((action) => action.fields ?? [])].map(
      (field) => field.type,
    ),
  );
  assert.ok(!kinds.has('secret') && !kinds.has('password'), 'the LIFX LAN protocol has no key');
  const world = await createdWorld(t);
  const lines = await capture(
    t,
    async () => {
      await world.poll();
      await world.hub.rediscover();
    },
    'debug',
  );
  const text = lines.join('\n');
  assert.ok(lines.length > 0, 'the debug level shows the details');
  assert.doesNotMatch(text, /token|password|secret|Bearer/i);
});

test('polling: the hub reads by its own timer, without any onPoll; devices have should_poll false', async (t) => {
  // Only the intervals are simulated: the UDP retries keep their real timers.
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  const world = await createdWorld(t, { timers: true, now: () => clock });
  assert.ok(world.fake.discoveredDevices.every((device) => device.should_poll === false));
  const reads = t.mock.method(world.hub, 'refresh');

  world.light.color.brightness = 6554;
  t.mock.timers.tick(14_000);
  await world.hub.idle();
  assert.equal(reads.mock.callCount(), 0, 'not before the interval');
  clock += 15_000;
  t.mock.timers.tick(1_000);
  await world.hub.idle();
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(brightness(world), 10);
});

/** A datagram shortened by hand: its size field follows. */
function fixSize(packet) {
  const copy = Buffer.from(packet);
  copy.writeUInt16LE(copy.length, 0);
  return copy;
}
