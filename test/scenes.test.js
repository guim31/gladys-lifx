// -----------------------------------------------------------------------------
// The scene actions: the pulse (an alert that ends by itself, the light back
// as it was, off included) and the firmware effects with their options.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import { PALETTES } from '../src/lifx/effects.js';
import { FAKE_TYPES } from './helpers/fakeLifx.js';
import {
  BEAM,
  CANDLE,
  COLOR_BULB,
  TILE,
  WHITE_BULB,
  Z_STRIP,
  createAll,
  createWorld,
  deviceId,
  featureId,
} from './helpers/world.js';

async function createdWorld(t, options) {
  const world = await createWorld(options);
  t.after(() => world.stop());
  await createAll(world);
  return world;
}

const action = (world, key, fields) =>
  world.fake.sceneAction(key, { device: deviceId(world.gladys, world.light.serial), ...fields });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('pulse: a light that is on blinks in the colour and comes back by itself', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  const bulb = world.light;
  const before = { ...bulb.color };
  const ack = await action(world, 'pulse', {
    color: 'red',
    mode: 'blink',
    period: '500',
    cycles: 4,
  });
  assert.deepEqual(ack, { success: true, data: { outputs: { duration_seconds: 2 } } });
  assert.deepEqual(bulb.lastWaveform, {
    transient: true,
    color: { hue: 0, saturation: 65535, brightness: 65535, kelvin: 3500 },
    period: 500,
    cycles: 4,
    skew: 0,
    waveform: 4,
  });
  assert.deepEqual(bulb.color, before, 'a transient waveform: the light goes back by itself');
  assert.equal(bulb.sent(FAKE_TYPES.SET_LIGHT_POWER).length, 0);
});

test('pulse: a light that is off lights up for it, then goes back off with its colour', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  const bulb = world.light;
  bulb.power = 0;
  bulb.color = { hue: 30000, saturation: 20000, brightness: 40000, kelvin: 2700 };
  const ack = await action(world, 'pulse', {
    color: 'blue',
    mode: 'breathe',
    period: '250',
    cycles: 1,
  });
  assert.equal(ack.success, true);
  assert.equal(bulb.lastWaveform.waveform, 1, 'breathe: a sine');
  assert.equal(bulb.lastWaveform.color.hue, 43690);
  assert.equal(bulb.power, 65535, 'on for the pulse');
  const [dark] = bulb.sent(FAKE_TYPES.SET_COLOR);
  assert.equal(dark.payload.readUInt16LE(5), 0, 'starts dark in the alert colour');

  await wait(600);
  await world.hub.idle();
  assert.equal(bulb.power, 0, 'off again');
  assert.deepEqual(bulb.color, { hue: 30000, saturation: 20000, brightness: 40000, kelvin: 2700 });
  assert.equal(world.fake.lastState(featureId(world.gladys, bulb.serial, FEATURE_KEYS.POWER)), 0);
});

test('pulse: a command during the pulse is not undone by the end of it', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  const bulb = world.light;
  bulb.power = 0;
  await action(world, 'pulse', { period: '250', cycles: 1 });
  const device = world.fake.discoveredDevices[0];
  const power = device.features.find((feature) => feature.external_id.endsWith(':power'));
  await world.fake.setValue(device, power, 1);
  await wait(600);
  await world.hub.idle();
  assert.equal(bulb.power, 65535, 'still on, as asked');
});

test('pulse: defaults, and a white bulb pulses in white', async (t) => {
  const world = await createdWorld(t, { lights: [WHITE_BULB] });
  const bulb = world.light;
  const ack = await action(world, 'pulse', {});
  assert.deepEqual(ack.data.outputs, { duration_seconds: 3 });
  assert.equal(bulb.lastWaveform.color.saturation, 0);
  assert.equal(bulb.lastWaveform.color.brightness, 65535);
  assert.equal(bulb.lastWaveform.cycles, 3);
  assert.equal(bulb.lastWaveform.period, 1000);
  assert.equal(bulb.lastWaveform.waveform, 4);
});

test('pulse: the cycles are bounded, an unknown colour is refused', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  await action(world, 'pulse', { cycles: 500, period: '250' });
  assert.equal(world.light.lastWaveform.cycles, 50);
  const refused = await action(world, 'pulse', { color: 'ultraviolet' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /Unknown pulse color/);
});

test('pulse: a light that does not answer fails the action', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  world.light.online = false;
  const ack = await action(world, 'pulse', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /does not answer/);
});

test('effect: Move paints the palette along an extended strip, then slides it', async (t) => {
  const world = await createdWorld(t, { lights: [Z_STRIP] });
  const strip = world.light;
  const ack = await action(world, 'start_effect', {
    effect: 'move',
    speed: 'fast',
    direction: 'left',
    palette: 'ocean',
  });
  assert.deepEqual(ack.data.outputs, { effect: 'move' });
  assert.deepEqual(strip.lastEffect, { type: 1, speed: 1000, direction: 1 });
  assert.equal(strip.sent(FAKE_TYPES.SET_EXT_ZONES).length, 1, '16 zones: one message');
  assert.equal(strip.lastApply, 1);
  const hues = new Set(strip.zones.map((zone) => zone.hue));
  assert.equal(hues.size, PALETTES.ocean.length, 'every colour of the palette is painted');
  assert.equal(strip.zones[0].brightness, 65535, 'at the brightness of the strip');
  assert.equal(
    world.fake.lastState(featureId(world.gladys, strip.serial, FEATURE_KEYS.EFFECT)),
    'move',
  );
});

test('effect: on a legacy strip, Move paints one band per colour', async (t) => {
  const world = await createdWorld(t, { lights: [BEAM] });
  const beam = world.light;
  await action(world, 'start_effect', { effect: 'move', palette: 'fire' });
  const bands = beam.sent(FAKE_TYPES.SET_COLOR_ZONES);
  assert.equal(bands.length, PALETTES.fire.length);
  assert.deepEqual(
    bands.map((band) => band.payload.readUInt8(14)),
    [0, 0, 0, 0, 1],
    'buffered, applied by the last one',
  );
  assert.equal(beam.zones[0].hue, 0);
  assert.notEqual(beam.zones[9].hue, 0);
  assert.equal(beam.lastEffect.speed, 3000);
  assert.equal(beam.lastEffect.direction, 0, 'right by default');
});

test('effect: Move with the colours already shown paints nothing', async (t) => {
  const world = await createdWorld(t, { lights: [Z_STRIP] });
  await action(world, 'start_effect', { effect: 'move', palette: 'current' });
  assert.equal(world.light.sent(FAKE_TYPES.SET_EXT_ZONES).length, 0);
  assert.equal(world.light.effect, 1);
});

test('effect: Morph blends the palette on a matrix, Flame keeps its colours', async (t) => {
  const world = await createdWorld(t, { lights: [CANDLE] });
  const candle = world.light;
  assert.equal(candle.power, 0);
  await action(world, 'start_effect', { effect: 'morph', speed: 'slow', palette: 'pastel' });
  assert.equal(candle.lastEffect.type, 2);
  assert.equal(candle.lastEffect.speed, 8000);
  assert.equal(candle.lastEffect.palette.length, PALETTES.pastel.length);
  assert.equal(candle.power, 65535, 'the light is turned on');

  await action(world, 'start_effect', { effect: 'flame' });
  assert.equal(candle.lastEffect.type, 3);
  assert.deepEqual(candle.lastEffect.palette, []);

  await action(world, 'start_effect', { effect: 'morph', palette: 'current' });
  assert.equal(candle.lastEffect.palette.length, PALETTES.rainbow.length, 'Morph needs colours');
});

test('effect: stop, and the effects a product does not have', async (t) => {
  const world = await createdWorld(t, { lights: [TILE] });
  const stopped = await action(world, 'start_effect', { effect: 'stop' });
  assert.deepEqual(stopped.data.outputs, { effect: 'none' });
  assert.equal(world.light.effect, 0);
  const refused = await action(world, 'start_effect', { effect: 'move' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /cannot run the effect "move"/);
});

test('effect: a bulb has no effect to stop', async (t) => {
  const world = await createdWorld(t, { lights: [COLOR_BULB] });
  const refused = await action(world, 'start_effect', { effect: 'stop' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /has no effect/);
});
