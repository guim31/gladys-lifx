// -----------------------------------------------------------------------------
// The firmware effects of the LIFX strips and matrices, the alert pulse, and
// the colour names the scene actions offer (a scene action field has no
// colour picker).
//
// Firmware effects run on the device until stopped, with no traffic from the
// integration: Move slides the colours of a strip (Z, Beam, Neon, String...),
// Morph blends a palette and Flame flickers on a matrix (Tile, Candle, Ceiling,
// Spot, Path, Tube...). The keys below are part of the manifest and of the
// effect list of the devices: permanent.
// -----------------------------------------------------------------------------

import { MULTI_ZONE_EFFECTS, TILE_EFFECTS, WAVEFORMS } from './packet.js';
import { hueFromDegrees } from './color.js';

export const NO_EFFECT = 'none';
// A firmware effect the integration does not start (Sky, Color Sweep... from
// the LIFX app): shown, never sent.
export const OTHER_EFFECT = 'other';

export const EFFECTS = {
  move: { family: 'multizone', type: MULTI_ZONE_EFFECTS.MOVE },
  morph: { family: 'matrix', type: TILE_EFFECTS.MORPH },
  flame: { family: 'matrix', type: TILE_EFFECTS.FLAME },
};

/** The effects a device can run, by key, in display order. */
export function effectsOf(caps) {
  return Object.entries(EFFECTS)
    .filter(([, effect]) => (effect.family === 'multizone' ? caps.multizone : caps.matrix))
    .map(([key]) => key);
}

/** Effect key of a StateMultiZoneEffect / StateTileEffect type. */
export function effectKey(family, type) {
  if (type === 0) {
    return NO_EFFECT;
  }
  const found = Object.entries(EFFECTS).find(
    ([, effect]) => effect.family === family && effect.type === type,
  );
  return found ? found[0] : OTHER_EFFECT;
}

// Milliseconds per cycle (Move: one pass of the strip; Morph and Flame: the
// pace of the animation, faster when shorter), the LIFX app range.
export const SPEEDS = { slow: 8000, normal: 3000, fast: 1000 };
export const DEFAULT_SPEED = 'normal';

// Move: which way the colours slide (parameter 1 of the effect).
export const DIRECTIONS = { right: 0, left: 1 };
export const DEFAULT_DIRECTION = 'right';

// Palettes, as hues in degrees with a saturation (0-1): painted along a strip
// before Move, blended by Morph. Their brightness is the light's own.
export const PALETTES = {
  rainbow: [
    [0, 1],
    [40, 1],
    [60, 1],
    [120, 1],
    [180, 1],
    [240, 1],
    [280, 1],
    [320, 1],
  ],
  fire: [
    [0, 1],
    [15, 1],
    [30, 1],
    [45, 1],
    [20, 0.9],
  ],
  ocean: [
    [170, 1],
    [190, 1],
    [210, 1],
    [230, 1],
    [200, 0.6],
  ],
  forest: [
    [80, 1],
    [100, 1],
    [120, 1],
    [140, 0.9],
    [60, 0.8],
  ],
  pastel: [
    [0, 0.35],
    [60, 0.35],
    [120, 0.35],
    [200, 0.35],
    [280, 0.35],
  ],
};
export const DEFAULT_PALETTE = 'rainbow';
// Move without painting: the colours already on the strip (set in the LIFX
// app, or by a previous effect) slide.
export const KEEP_COLORS = 'current';

/** The HSBK colours of a palette, at a brightness (0-65535) and kelvin. */
export function paletteColors(name, brightness, kelvin) {
  const palette = PALETTES[name] ?? PALETTES[DEFAULT_PALETTE];
  return palette.map(([degrees, saturation]) => ({
    hue: hueFromDegrees(degrees),
    saturation: Math.round(saturation * 0xffff),
    brightness,
    kelvin,
  }));
}

// --- Pulse ---------------------------------------------------------------------

// The colour of an alert: hue in degrees and saturation, or a white.
export const PULSE_COLORS = {
  red: [0, 1],
  orange: [30, 1],
  yellow: [55, 1],
  green: [120, 1],
  cyan: [180, 1],
  blue: [240, 1],
  purple: [275, 1],
  pink: [320, 0.7],
  white: null,
};
export const DEFAULT_PULSE_COLOR = 'red';

// Blink: a square wave, half the cycle on the alert colour. Breathe: a sine.
export const PULSE_MODES = {
  blink: { waveform: WAVEFORMS.PULSE },
  breathe: { waveform: WAVEFORMS.SINE },
};
export const DEFAULT_PULSE_MODE = 'blink';

// Length of one cycle, in ms (manifest `period` options).
export const PULSE_PERIODS = [250, 500, 1000, 2000, 5000];
export const DEFAULT_PULSE_PERIOD = 1000;

export const PULSE_CYCLES = { min: 1, max: 50, default: 3 };
