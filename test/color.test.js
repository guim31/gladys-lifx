import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromPercent,
  hsbkToRgbInt,
  isWhite,
  rgbIntToHueSaturation,
  toPercent,
} from '../src/lifx/color.js';

test('primary colours go both ways between the Gladys RGB and the LIFX hue', () => {
  const cases = [
    [0xff0000, 0, 65535],
    [0x00ff00, 21845, 65535],
    [0x0000ff, 43690, 65535],
    [0xffff00, 10923, 65535],
    [0xffffff, 0, 0],
  ];
  for (const [rgb, hue, saturation] of cases) {
    assert.deepEqual(rgbIntToHueSaturation(rgb), { hue, saturation }, rgb.toString(16));
    assert.equal(hsbkToRgbInt({ hue, saturation }), rgb, rgb.toString(16));
  }
});

test('a dark colour keeps its hue: its darkness is the brightness feature', () => {
  assert.deepEqual(rgbIntToHueSaturation(0x800000), { hue: 0, saturation: 65535 });
  assert.equal(hsbkToRgbInt({ hue: 0, saturation: 32768 }), 0xff7f7f);
});

test('percentages', () => {
  assert.equal(toPercent(65535), 100);
  assert.equal(toPercent(32768), 50);
  assert.equal(toPercent(0), 0);
  assert.equal(fromPercent(100), 65535);
  assert.equal(fromPercent(1), 655);
  assert.equal(fromPercent(150), 65535);
});

test('a white is a saturation under 1 %', () => {
  assert.equal(isWhite({ saturation: 0 }), true);
  assert.equal(isWhite({ saturation: 500 }), true);
  assert.equal(isWhite({ saturation: 65535 }), false);
  assert.equal(isWhite(null), true);
});
