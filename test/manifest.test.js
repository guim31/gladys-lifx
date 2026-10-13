// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, POLL_INTERVALS, TRANSITIONS } from '../src/config.js';
import { SCENE_ACTIONS } from '../src/scenes.js';
import {
  DEFAULT_DIRECTION,
  DEFAULT_PALETTE,
  DEFAULT_PULSE_COLOR,
  DEFAULT_PULSE_MODE,
  DEFAULT_PULSE_PERIOD,
  DEFAULT_SPEED,
  DIRECTIONS,
  EFFECTS,
  KEEP_COLORS,
  PALETTES,
  PULSE_COLORS,
  PULSE_CYCLES,
  PULSE_MODES,
  PULSE_PERIODS,
  SPEEDS,
} from '../src/lifx/effects.js';
import { LIFX_PORT } from '../src/lifx/packet.js';
import { createWorld } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);
const valuesOf = (field) => field.options.map((option) => option.value);
const sceneAction = (key) => manifest.scene_actions.find((entry) => entry.key === key);
const fieldOf = (action, key) => sceneAction(action).fields.find((field) => field.key === key);

// Minimum version of the manifest `gladys_version` range, e.g. [5, 1, 0].
function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('identity: name, image, cover, local transport, lighting, UDP discovery', () => {
  assert.equal(manifest.name, 'LIFX');
  assert.equal(manifest.type, 'device');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-lifx:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-lifx/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['lighting']);
  // The port the code broadcasts on must be declared, or the core answers 403.
  assert.deepEqual(manifest.network_discovery, [
    { type: 'udp-active-broadcast', ports: [LIFX_PORT] },
  ]);
});

test('every manifest action has a handler', async (t) => {
  const world = await createWorld({ lights: [] });
  t.after(() => world.stop());
  assert.deepEqual(keysOf(manifest.actions), ['search']);
  for (const action of manifest.actions) {
    const ack = await world.fake.action(action.key, {});
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(
    isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('scene actions require Gladys >= 5.1.0; no widget, so no 5.2.0 form button', () => {
  assert.ok(manifest.scene_actions.length > 0);
  assert.equal(manifest.widgets, undefined, 'no widget: see README, "Why no widget"');
  assert.equal(manifest.scene_triggers, undefined);
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `scene_actions requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every scene_actions key has an onSceneAction handler, and vice versa', () => {
  const declared = keysOf(manifest.scene_actions);
  assert.deepEqual(declared, ['pulse', 'start_effect']);
  for (const key of declared) {
    assert.equal(typeof SCENE_ACTIONS[key], 'function', `scene action "${key}" has no handler`);
  }
  for (const key of Object.keys(SCENE_ACTIONS)) {
    assert.ok(declared.includes(key), `handler "${key}" is not declared in scene_actions`);
  }
});

test('the pulse options of the manifest are the ones of the code', () => {
  assert.deepEqual(valuesOf(fieldOf('pulse', 'color')), Object.keys(PULSE_COLORS));
  assert.equal(fieldOf('pulse', 'color').default, DEFAULT_PULSE_COLOR);
  assert.deepEqual(valuesOf(fieldOf('pulse', 'mode')), Object.keys(PULSE_MODES));
  assert.equal(fieldOf('pulse', 'mode').default, DEFAULT_PULSE_MODE);
  assert.deepEqual(valuesOf(fieldOf('pulse', 'period')).map(Number), PULSE_PERIODS);
  assert.equal(Number(fieldOf('pulse', 'period').default), DEFAULT_PULSE_PERIOD);
  const cycles = fieldOf('pulse', 'cycles');
  assert.deepEqual(
    [cycles.min, cycles.max, cycles.default],
    [PULSE_CYCLES.min, PULSE_CYCLES.max, PULSE_CYCLES.default],
  );
  assert.deepEqual(keysOf(sceneAction('pulse').outputs), ['duration_seconds']);
});

test('the effect options of the manifest are the ones of the code', () => {
  assert.deepEqual(valuesOf(fieldOf('start_effect', 'effect')), [...Object.keys(EFFECTS), 'stop']);
  assert.deepEqual(valuesOf(fieldOf('start_effect', 'speed')), Object.keys(SPEEDS));
  assert.equal(fieldOf('start_effect', 'speed').default, DEFAULT_SPEED);
  assert.deepEqual(valuesOf(fieldOf('start_effect', 'direction')), Object.keys(DIRECTIONS));
  assert.equal(fieldOf('start_effect', 'direction').default, DEFAULT_DIRECTION);
  assert.deepEqual(valuesOf(fieldOf('start_effect', 'palette')), [
    ...Object.keys(PALETTES),
    KEEP_COLORS,
  ]);
  assert.equal(fieldOf('start_effect', 'palette').default, DEFAULT_PALETTE);
  assert.deepEqual(keysOf(sceneAction('start_effect').outputs), ['effect']);
});

test('the scene action outputs are the ones the handlers resolve', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const [device] = world.fake.discoveredDevices;
  await world.fake.deviceCreated(device);
  const ack = await world.fake.sceneAction('pulse', { device: device.external_id, period: '250' });
  assert.deepEqual(Object.keys(ack.data.outputs), keysOf(sceneAction('pulse').outputs));
});

test('the refresh intervals and fades of the manifest are the ones the code accepts', () => {
  const field = (key) => manifest.config_schema.find((entry) => entry.key === key);
  assert.deepEqual(valuesOf(field('poll_interval')).map(Number), POLL_INTERVALS);
  assert.deepEqual(valuesOf(field('transition')).map(Number), TRANSITIONS);
  // The pace asked for this integration: every 10 to 30 s by default.
  assert.ok(POLL_INTERVALS.includes(10) && POLL_INTERVALS.includes(30));
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('number fields: integer bounds and defaults (the form has no step)', () => {
  for (const field of allFields.filter((entry) => entry.type === 'number')) {
    for (const key of ['min', 'max', 'default']) {
      if (field[key] !== undefined) {
        assert.ok(Number.isInteger(field[key]), `${field.key}.${key} must be an integer`);
      }
    }
  }
});

test('select defaults are among their options', () => {
  for (const field of allFields.filter((entry) => entry.options && entry.default !== undefined)) {
    assert.ok(valuesOf(field).includes(field.default), `${field.key}: default not an option`);
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the configuration opens with a section block');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'the device fields are dynamic selects');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices');
    assert.equal(field.options, undefined);
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  const withPlaceholder = allFields.filter((f) => f.placeholder !== undefined);
  assert.ok(withPlaceholder.length > 0, 'the address field has a placeholder');
  for (const field of withPlaceholder) {
    assert.equal(typeof field.placeholder, 'object', `field "${field.key}": placeholder`);
    assert.ok(field.placeholder.en, `field "${field.key}": placeholder needs an English text`);
  }
});
