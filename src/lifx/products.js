// -----------------------------------------------------------------------------
// What a LIFX device can do, from its product id (GetVersion) and its firmware
// (GetHostFirmware), read in the LIFX product registry (products-data.js):
// colour or white only, white range in kelvins, infrared, zones (strips) or a
// matrix (Tile, Candle, Ceiling...).
//
// The registry lists the features of each product, then the firmware versions
// that change them (a newer firmware widens the white range of many models,
// or brings the extended multizone messages): the LIFX recipe of the
// registry README is applied as is.
// -----------------------------------------------------------------------------

import { DEFAULT_FEATURES, PRODUCTS } from './products-data.js';

export const LIFX_VENDOR = 1;

// A product the registry does not list yet (newer than this release): most
// LIFX lights are colour lights, and this range is the most common one.
export const UNKNOWN_PRODUCT_FEATURES = { color: true, temperature_range: [1500, 9000] };

const BY_PID = new Map(PRODUCTS.map((product) => [product.pid, product]));

const atLeast = (firmware, upgrade) =>
  firmware.major > upgrade.major ||
  (firmware.major === upgrade.major && firmware.minor >= upgrade.minor);

/**
 * Capabilities of a device, or null when it is not a light (the LIFX Switch:
 * relays and buttons, no light).
 * @param {object} version `{ vendor, product }` from StateVersion
 * @param {object} firmware `{ major, minor }` from StateHostFirmware
 */
export function capabilitiesOf(version, firmware = { major: 0, minor: 0 }) {
  const known = version?.vendor === LIFX_VENDOR ? BY_PID.get(version.product) : undefined;
  const features = {
    ...DEFAULT_FEATURES,
    ...(known ? known.features : UNKNOWN_PRODUCT_FEATURES),
  };
  for (const upgrade of known?.upgrades ?? []) {
    if (atLeast(firmware, upgrade)) {
      Object.assign(features, upgrade.features);
    }
  }
  const range = features.temperature_range;
  if (!Array.isArray(range) || range.length !== 2) {
    return null;
  }
  const [min, max] = range;
  return {
    known: Boolean(known),
    product: known?.name ?? null,
    color: features.color === true,
    kelvin: { min, max },
    // A fixed white (2700 K bulbs, filaments) has no temperature to set.
    temperature: max > min,
    infrared: features.infrared === true,
    multizone: features.multizone === true,
    extendedMultizone: features.extended_multizone === true,
    matrix: features.matrix === true,
    firmware: `${firmware.major}.${firmware.minor}`,
  };
}
