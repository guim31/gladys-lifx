// -----------------------------------------------------------------------------
// From the LIFX colour model to the Gladys features, and back.
//
// A LIFX light holds one HSBK: hue, saturation and brightness on 0-65535, and
// a white temperature in kelvins (used when the saturation is low). Gladys
// keeps the colour (an RGB integer), the brightness (%) and the white
// temperature (K) as three features: the colour is the hue and saturation at
// full value, the brightness stays its own feature, like the other Gladys
// lights. A colour command therefore never changes the brightness.
// -----------------------------------------------------------------------------

export const U16 = 0xffff;

// Below this saturation, the light shows a white: the LIFX app writes 0 for
// its whites, a tiny rounding error must not turn them into a colour.
export const WHITE_SATURATION = Math.round(U16 * 0.01);

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 0-65535 → 0-100 %. */
export const toPercent = (value) => clamp(Math.round((value / U16) * 100), 0, 100);

/** 0-100 % → 0-65535. */
export const fromPercent = (percent) => clamp(Math.round((percent / 100) * U16), 0, U16);

/** Hue (0-65535) and saturation (0-65535) → RGB integer at full value. */
export function hsbkToRgbInt({ hue, saturation }) {
  const h = ((hue / U16) * 360) % 360;
  const s = clamp(saturation / U16, 0, 1);
  const chroma = s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - chroma;
  const sector = Math.floor(h / 60);
  const [r, g, b] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ][sector] ?? [chroma, x, 0];
  const channel = (value) => clamp(Math.round((value + m) * 255), 0, 255);
  return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

/**
 * RGB integer → LIFX hue and saturation (0-65535). The value of the colour
 * (how dark it is) is left out: it is the brightness feature's business.
 */
export function rgbIntToHueSaturation(rgb) {
  const value = clamp(Math.round(Number(rgb) || 0), 0, 0xffffff);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta + 6) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }
  const s = max === 0 ? 0 : delta / max;
  return {
    hue: clamp(Math.round((h / 360) * U16), 0, U16),
    saturation: clamp(Math.round(s * U16), 0, U16),
  };
}

/** Hue in degrees (0-360) → 0-65535. */
export const hueFromDegrees = (degrees) => clamp(Math.round(((degrees % 360) / 360) * U16), 0, U16);

/** True when the HSBK shows a white rather than a colour. */
export const isWhite = (hsbk) => !(hsbk?.saturation >= WHITE_SATURATION);
