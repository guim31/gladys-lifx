// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake LIFX lights on real UDP
// sockets (127.0.0.1), and a temporary /data, with the integration wired on
// top through registerHandlers. No timer runs unless asked: the tests read the
// lights with `world.poll()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { FIXTURE_NAMES, FakeLifx, startLights } from './fakeLifx.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

// Fast retries: a light that does not answer fails in 80 ms.
export const FAST_TRANSPORT = {
  timeoutMs: 80,
  commandTimeoutMs: 80,
  firstRetryMs: 20,
  maxRetryMs: 20,
};

export const COLOR_BULB = 'a19-color-pid27-fw2.80';
export const OLD_BULB = 'original-pid1-fw1.5';
export const WHITE_BULB = 'mini-white-pid51-fw3.70';
export const NIGHTVISION = 'nightvision-pid109-fw3.90';
export const Z_STRIP = 'z-strip-pid32-fw2.77';
export const BEAM = 'beam-pid38-fw2.60';
export const TILE = 'tile-pid55-fw3.70';
export const CANDLE = 'candle-pid57-fw3.70';
export const SWITCH = 'switch-pid70-fw3.90';

/** Every fixture that is a light (the Switch is not). */
export const LIGHT_FIXTURES = FIXTURE_NAMES.filter((name) => name !== SWITCH);

/**
 * @param {object} [options]
 * @param {string[]} [options.lights] fixture names of the lights of the network
 * @param {boolean} [options.scan] whether the core's discovery finds them
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 * @param {boolean} [options.timers] the hub's own timers (off: the tests poll)
 */
export async function createWorld({
  lights = [COLOR_BULB],
  scan = true,
  config = { language: 'en' },
  created = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-lifx-')),
  timings = {},
  timers = false,
  now,
} = {}) {
  // A clock the tests move: the hub skips a light read less than half a
  // period ago, `world.poll()` moves it one period on.
  let clock = 1_000_000;
  const fakes = await startLights(lights);
  const gladys = createFakeGladys({
    config,
    devices: created,
    scanResults: {
      'udp-active-broadcast': scan ? fakes.flatMap((light) => light.scanReplies()) : [],
    },
  });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    timers,
    timings,
    transportTimings: FAST_TRANSPORT,
    now: now ?? (() => clock),
  });
  const world = {
    gladys,
    fake: gladys.fake,
    lights: fakes,
    light: fakes[0],
    app,
    hub: app.hub,
    dataDir,
    tick(ms) {
      clock += ms;
    },
    /** One period later, the timer's read of every added light. */
    async poll() {
      clock += app.hub.config.pollSeconds * 1000;
      await app.hub.pollAll();
    },
    async stop() {
      await app.stop();
      fakes.forEach((light) => light.close());
    },
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return world;
}

export const deviceId = (gladys, serial) => gladys.externalIds('lifx', serial).device;
export const featureId = (gladys, serial, key) => gladys.externalIds('lifx', serial).feature(key);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await world.hub.idle();
}

/** The Gladys device and feature of a light, as onSetValue receives them. */
export function target(world, light, key) {
  const device = world.fake.discoveredDevices.find(
    (entry) => entry.external_id === deviceId(world.gladys, light.serial),
  );
  const feature = device.features.find(
    (entry) => entry.external_id === featureId(world.gladys, light.serial, key),
  );
  return { device, feature };
}

export { FakeLifx, FIXTURE_NAMES };
