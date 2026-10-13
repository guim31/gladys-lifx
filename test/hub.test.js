// -----------------------------------------------------------------------------
// The hub against fake lights on real UDP and the SDK's fake Gladys:
// discovery, device payloads, states, commands, reachability, persistence.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS } from '../src/devices.js';
import { FAKE_TYPES } from './helpers/fakeLifx.js';
import {
  BEAM,
  COLOR_BULB,
  NIGHTVISION,
  OLD_BULB,
  SWITCH,
  TILE,
  WHITE_BULB,
  Z_STRIP,
  createAll,
  createWorld,
  deviceId,
  featureId,
  target,
} from './helpers/world.js';

async function createdWorld(t, options) {
  const world = await createWorld(options);
  t.after(() => world.stop());
  await createAll(world);
  return world;
}

const state = (world, light, key) =>
  world.fake.lastState(featureId(world.gladys, light.serial, key));

async function set(world, light, key, value) {
  const { device, feature } = target(world, light, key);
  return world.fake.setValue(device, feature, value);
}

test('discovery: the lights found by the core scan are published, named from the LIFX app', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB, WHITE_BULB, Z_STRIP, SWITCH] });
  t.after(() => world.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((device) => [device.name, device.model]),
    [
      ['Salon', 'LIFX (A19)'],
      ['Couloir', 'LIFX Mini W'],
      ['Ruban TV', 'LIFX Z'],
    ],
    'the LIFX Switch is not a light',
  );
  const [bulb] = devices;
  assert.equal(bulb.external_id, 'ext:test-integration:lifx:d073d5000001');
  assert.equal(bulb.should_poll, false);
  assert.equal(bulb.poll_frequency, undefined);
  assert.deepEqual(bulb.params, [
    { name: 'IP_ADDRESS', value: '127.0.0.1' },
    { name: 'SERIAL', value: 'd073d5000001' },
    { name: 'FIRMWARE', value: '2.80' },
  ]);
  // The scan went through the core, with a GetService packet.
  assert.equal(world.fake.scans.length, 1);
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('discovery: features follow the product', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB, WHITE_BULB, NIGHTVISION, Z_STRIP, TILE] });
  t.after(() => world.stop());
  const keys = (serial) =>
    world.fake.discoveredDevices
      .find((device) => device.external_id === deviceId(world.gladys, serial))
      .features.map((feature) => feature.external_id.split(':').pop());
  assert.deepEqual(keys('d073d5000001'), [
    'power',
    'brightness',
    'color',
    'color-temperature',
    'connected',
  ]);
  assert.deepEqual(keys('d073d5000003'), ['power', 'brightness', 'connected']);
  assert.ok(keys('d073d5000005').includes('infrared'));
  assert.ok(keys('d073d5000006').includes('effect'));
  const tile = world.fake.discoveredDevices.find((device) => device.name === 'Tiles');
  const effect = tile.features.find((feature) => feature.external_id.endsWith(':effect'));
  assert.deepEqual(
    effect.supported_options.map((option) => option.value),
    ['none', 'morph', 'flame', 'other'],
  );
  const bulb = world.fake.discoveredDevices[0];
  const temperature = bulb.features.find((feature) => feature.unit === 'kelvin');
  assert.deepEqual([temperature.min, temperature.max], [1500, 9000]);
});

test('a light without label is named after its product and serial', async (t) => {
  const world = await createWorld({ lights: ['filament-amber-pid85-fw3.70'] });
  t.after(() => world.stop());
  assert.equal(world.fake.discoveredDevices[0].name, 'LIFX Filament Amber 00000B');
});

test('states: published once the device is added, colour or white', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB, WHITE_BULB] });
  const [bulb, white] = world.lights;
  assert.equal(state(world, bulb, FEATURE_KEYS.POWER), 1);
  assert.equal(state(world, bulb, FEATURE_KEYS.BRIGHTNESS), 50);
  assert.equal(state(world, bulb, FEATURE_KEYS.COLOR), 0x00ff00);
  assert.equal(state(world, bulb, FEATURE_KEYS.TEMPERATURE), undefined, 'a colour, not a white');
  assert.equal(state(world, bulb, FEATURE_KEYS.CONNECTED), 1);
  assert.equal(state(world, white, FEATURE_KEYS.BRIGHTNESS), 69);
  assert.equal(world.fake.transports.at(-1).transport, 'local');

  // Changed in the LIFX app: a white.
  bulb.color = { hue: 0, saturation: 0, brightness: 65535, kelvin: 2700 };
  await world.poll();
  assert.equal(state(world, bulb, FEATURE_KEYS.TEMPERATURE), 2700);
  assert.equal(state(world, bulb, FEATURE_KEYS.BRIGHTNESS), 100);
});

test('states: nothing is published for a light the user did not add', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB] });
  t.after(() => world.stop());
  assert.equal(world.fake.states.length, 0);
  await world.poll();
  assert.equal(world.light.sent(FAKE_TYPES.LIGHT_GET).length, 1, 'only the discovery read');
});

test('states: only changes are sent, with a heartbeat of at most 12 h', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  const publish = t.mock.method(world.gladys, 'publishChangedStates');
  const before = world.fake.states.length;
  await world.poll();
  await world.poll();
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');
  for (const call of publish.mock.calls) {
    assert.ok(call.arguments[1].heartbeat <= 12 * 3_600_000);
  }
});

test('commands: on and off, with the configured transition', async (t) => {
  const world = await createdWorld(t, { config: { language: 'en', transition: '1000' } });
  const bulb = world.light;
  assert.deepEqual(await set(world, bulb, FEATURE_KEYS.POWER, 0), { success: true });
  assert.equal(bulb.power, 0);
  assert.equal(bulb.lastPowerDuration, 1000);
  assert.equal(state(world, bulb, FEATURE_KEYS.POWER), 0);
  await set(world, bulb, FEATURE_KEYS.POWER, 1);
  assert.equal(bulb.power, 65535);
  assert.equal(state(world, bulb, FEATURE_KEYS.POWER), 1);
});

test('commands: brightness writes only the brightness; 0 turns the light off', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  bulb.color.hue = 1234; // changed in the LIFX app since the last read
  await set(world, bulb, FEATURE_KEYS.BRIGHTNESS, 25);
  assert.equal(bulb.color.brightness, 16384);
  assert.equal(bulb.color.hue, 1234, 'the hue is not overwritten');
  assert.deepEqual(bulb.lastWaveformOptional.set, {
    hue: false,
    saturation: false,
    brightness: true,
    kelvin: false,
  });
  assert.equal(bulb.lastWaveformOptional.transient, false);
  assert.equal(state(world, bulb, FEATURE_KEYS.BRIGHTNESS), 25);

  await set(world, bulb, FEATURE_KEYS.BRIGHTNESS, 0);
  assert.equal(bulb.power, 0);
  assert.equal(bulb.color.brightness, 16384, 'the brightness is kept for the next time');
});

test('commands: a colour on a light that is off is set first, then the light fades on', async (t) => {
  const world = await createdWorld(t, { config: { language: 'en', transition: '500' } });
  const bulb = world.light;
  await set(world, bulb, FEATURE_KEYS.POWER, 0);
  bulb.received.length = 0;
  await set(world, bulb, FEATURE_KEYS.COLOR, 0xff0000);
  assert.deepEqual(
    bulb.received.map((request) => request.type),
    [FAKE_TYPES.SET_WAVEFORM_OPTIONAL, FAKE_TYPES.SET_LIGHT_POWER],
  );
  assert.equal(bulb.lastWaveformOptional.period, 0, 'no fade while off');
  assert.equal(bulb.lastPowerDuration, 500);
  assert.deepEqual([bulb.color.hue, bulb.color.saturation], [0, 65535]);
  assert.equal(bulb.color.brightness, 32768, 'a colour never changes the brightness');
  assert.equal(state(world, bulb, FEATURE_KEYS.COLOR), 0xff0000);
  assert.equal(state(world, bulb, FEATURE_KEYS.POWER), 1);
});

test('commands: a white sets the saturation to 0 and the kelvins, within the model range', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  await set(world, bulb, FEATURE_KEYS.TEMPERATURE, 12000);
  assert.equal(bulb.color.saturation, 0);
  assert.equal(bulb.color.kelvin, 9000);
  assert.equal(state(world, bulb, FEATURE_KEYS.TEMPERATURE), 9000);
});

test('commands: an old firmware without SetWaveformOptional gets SetColor', async (t) => {
  const world = await createdWorld(t, { lights: [OLD_BULB] });
  const bulb = world.light;
  await set(world, bulb, FEATURE_KEYS.COLOR, 0x0000ff);
  assert.equal(bulb.power, 65535);
  assert.equal(bulb.color.hue, 43690);
  assert.equal(bulb.color.kelvin, 3500, 'the rest of the colour is kept');
  bulb.received.length = 0;
  await set(world, bulb, FEATURE_KEYS.BRIGHTNESS, 10);
  assert.equal(bulb.sent(FAKE_TYPES.SET_WAVEFORM_OPTIONAL).length, 0, 'not tried again');
  assert.equal(bulb.sent(FAKE_TYPES.SET_COLOR).length, 1);
  assert.equal(bulb.color.brightness, 6554);
});

test('commands: infrared of a Nightvision bulb', async (t) => {
  const world = await createdWorld(t, { lights: [NIGHTVISION] });
  const bulb = world.light;
  assert.equal(state(world, bulb, FEATURE_KEYS.INFRARED), 50);
  await set(world, bulb, FEATURE_KEYS.INFRARED, 100);
  assert.equal(bulb.infrared, 65535);
  assert.equal(state(world, bulb, FEATURE_KEYS.INFRARED), 100);
});

test('commands: a colour stops the effect that would cover it', async (t) => {
  const world = await createdWorld(t, { lights: [BEAM] });
  const beam = world.light;
  assert.deepEqual(state(world, beam, FEATURE_KEYS.EFFECT), 'move');
  await set(world, beam, FEATURE_KEYS.COLOR, 0xff0000);
  assert.equal(beam.effect, 0);
  assert.deepEqual(state(world, beam, FEATURE_KEYS.EFFECT), 'none');
});

test('commands: the effect list starts and stops the firmware effects', async (t) => {
  const world = await createdWorld(t, { lights: [TILE] });
  const tile = world.light;
  assert.deepEqual(state(world, tile, FEATURE_KEYS.EFFECT), 'morph');
  await set(world, tile, FEATURE_KEYS.EFFECT, 'flame');
  assert.equal(tile.effect, 3);
  assert.deepEqual(state(world, tile, FEATURE_KEYS.EFFECT), 'flame');
  await set(world, tile, FEATURE_KEYS.EFFECT, 'none');
  assert.equal(tile.effect, 0);
  const ack = await set(world, tile, FEATURE_KEYS.EFFECT, 'move');
  assert.equal(ack.success, false, 'a Tile has no Move');
});

test('commands: the connection is read-only; an unknown device is refused', async (t) => {
  const world = await createdWorld(t);
  const ack = await set(world, world.light, FEATURE_KEYS.CONNECTED, 1);
  assert.equal(ack.success, false);
  const unknown = await world.fake.setValue(
    { external_id: 'ext:test-integration:lifx:d073d5ffffff' },
    { external_id: 'ext:test-integration:lifx:d073d5ffffff:power' },
    1,
  );
  assert.equal(unknown.success, false);
});

test('reads wait for a command to settle', async (t) => {
  const world = await createdWorld(t, { config: { language: 'en', transition: '5000' } });
  const bulb = world.light;
  // Read long ago: only the settle delay can hold the next read.
  world.tick(60_000);
  await set(world, bulb, FEATURE_KEYS.POWER, 0);
  bulb.received.length = 0;
  world.tick(6000); // the 5 s fade and 1 s of the 1.5 s settle delay
  await world.hub.pollAll();
  assert.equal(bulb.sent(FAKE_TYPES.LIGHT_GET).length, 0, 'still settling');
  world.tick(1000);
  await world.hub.pollAll();
  assert.equal(bulb.sent(FAKE_TYPES.LIGHT_GET).length, 1);
});

test('the timer skips a light read less than half a period ago', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  bulb.received.length = 0;
  world.tick(7000);
  await world.hub.pollAll();
  assert.equal(bulb.sent(FAKE_TYPES.LIGHT_GET).length, 0, 'read 7 s ago at its creation');
  world.tick(1000);
  await world.hub.pollAll();
  assert.equal(bulb.sent(FAKE_TYPES.LIGHT_GET).length, 1);
});

test('a reading started before a command is dropped', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  world.tick(15_000);
  const reading = world.hub.refresh(world.hub.records.get(bulb.serial));
  world.hub.records.get(bulb.serial).commandSeq += 1; // a command meanwhile
  bulb.color.brightness = 655;
  await reading;
  assert.equal(state(world, bulb, FEATURE_KEYS.BRIGHTNESS), 50, 'the stale reading is not shown');
});

test('reachability: a light that stops answering is shown off and unreachable, then back', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  bulb.online = false;
  await world.poll();
  assert.equal(state(world, bulb, FEATURE_KEYS.CONNECTED), 1, 'one miss is not enough');
  await world.poll();
  assert.equal(state(world, bulb, FEATURE_KEYS.CONNECTED), 0);
  assert.equal(state(world, bulb, FEATURE_KEYS.POWER), 0);
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(world.fake.connectionStatus.connected, false);

  bulb.online = true;
  await world.poll();
  assert.equal(state(world, bulb, FEATURE_KEYS.CONNECTED), 1);
  assert.equal(state(world, bulb, FEATURE_KEYS.POWER), 1);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('a command to a light that does not answer fails with a clear message', async (t) => {
  const world = await createdWorld(t);
  world.light.online = false;
  const ack = await set(world, world.light, FEATURE_KEYS.POWER, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /LIFX "Salon" does not answer/);
});

test('typed addresses: a light the scan does not find is reached in unicast', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB], scan: false, connect: false });
  t.after(() => world.stop());
  // The typed address uses the standard port; the fake light listens elsewhere.
  world.hub.defaultPort = world.light.port;
  world.fake.config = { language: 'en', hosts: '127.0.0.1, 300.1.2.3' };
  await world.gladys.connect();
  await world.app.ready;
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['Salon'],
  );
  const report = await world.fake.action('search', {});
  assert.match(
    report.data.message.en,
    /1 light, 1 answering: Salon \(127\.0\.0\.1, LIFX \(A19\)\)/,
  );
  assert.match(report.data.message.en, /Ignored addresses: 300\.1\.2\.3/);
});

test('no light at all: the connection status says why', async (t) => {
  const world = await createWorld({ lights: [] });
  t.after(() => world.stop());
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /Aucune lampe LIFX trouvée/);
  const report = await world.fake.action('search', {});
  assert.equal(report.data.message.de, 'Keine LIFX-Lampe gefunden.');
});

test('a core without the mediated discovery: the search report says so', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB], connect: false });
  t.after(() => world.stop());
  t.mock.method(world.gladys, 'scanNetwork', async () => {
    throw new GladysApiError(403, 'FORBIDDEN', 'network_discovery not declared');
  });
  await world.gladys.connect();
  await world.app.ready;
  const report = await world.fake.action('search', {});
  assert.match(report.data.message.en, /Automatic discovery through Gladys is unavailable/);
});

test('persistence: a restart knows the lights before they answer', async (t) => {
  const first = await createWorld({ lights: [Z_STRIP] });
  await first.stop();
  const second = await createWorld({ lights: [], dataDir: first.dataDir });
  t.after(() => second.stop());
  const [device] = second.fake.discoveredDevices;
  assert.equal(device.name, 'Ruban TV');
  assert.ok(device.features.some((feature) => feature.external_id.endsWith(':effect')));
  assert.equal(second.hub.summary().devices[0].reachable, false);
});

test('a light that moved (DHCP) keeps its device, with its new address', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB] });
  t.after(() => world.stop());
  const record = world.hub.records.get('d073d5000001');
  record.host = '192.0.2.10';
  await world.hub.rediscover();
  assert.equal(record.host, '127.0.0.1');
  assert.equal(world.fake.discoveredDevices.length, 1);
});

test('configuration: another language renames the features of the Discovery list', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB], config: {} });
  t.after(() => world.stop());
  const names = () => world.fake.discoveredDevices[0].features.map((feature) => feature.name);
  assert.deepEqual(names(), [
    'Éclairage',
    'Luminosité',
    'Couleur',
    'Température de couleur',
    'Connexion',
  ]);
  await world.fake.configUpdated({ language: 'de' });
  assert.deepEqual(names(), ['Licht', 'Helligkeit', 'Farbe', 'Farbtemperatur', 'Verbindung']);
});

test('a device added later gets its states at once', async (t) => {
  const world = await createWorld({ lights: [COLOR_BULB] });
  t.after(() => world.stop());
  const [device] = world.fake.discoveredDevices;
  await world.fake.deviceCreated(device);
  assert.equal(state(world, world.light, FEATURE_KEYS.POWER), 1);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('onPoll (fallback) reads a light the timer has not read for half a period', async (t) => {
  const world = await createdWorld(t);
  const bulb = world.light;
  const [device] = world.fake.discoveredDevices;
  bulb.received.length = 0;
  await world.fake.poll(device);
  assert.equal(bulb.sent(FAKE_TYPES.LIGHT_GET).length, 0, 'just read at creation');
  world.tick(8_000);
  bulb.color.brightness = 65535;
  await world.fake.poll(device);
  assert.equal(bulb.sent(FAKE_TYPES.LIGHT_GET).length, 1);
  assert.equal(state(world, bulb, FEATURE_KEYS.BRIGHTNESS), 100);
});
