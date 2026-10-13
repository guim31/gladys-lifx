// -----------------------------------------------------------------------------
// From a LIFX light to a Gladys device: discovery payload and state values.
//
// One Gladys device per LIFX bulb, strip or matrix, keyed on its serial (the
// MAC-like identifier LIFX prints on the device). Only what the product can
// do is published: a white bulb has no colour, a fixed white (filament, 2700 K
// bulb) no temperature, the white range is the one of the model and firmware,
// a Nightvision bulb gets its infrared, a strip or a matrix its effect list.
//
// Feature keys are part of the external ids: permanent.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { clamp, hsbkToRgbInt, isWhite, toPercent } from './lifx/color.js';
import { NO_EFFECT, OTHER_EFFECT, effectsOf } from './lifx/effects.js';

export const DEVICE_TYPE = 'lifx';

export const FEATURE_KEYS = {
  POWER: 'power',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  TEMPERATURE: 'color-temperature',
  INFRARED: 'infrared',
  EFFECT: 'effect',
  CONNECTED: 'connected',
};

// Feature names are frozen when the user creates the device: written in the
// language chosen in the configuration at that moment.
export const NAMES = {
  en: {
    light: 'Light',
    brightness: 'Brightness',
    color: 'Color',
    'color-temperature': 'Color temperature',
    infrared: 'Infrared',
    effect: 'LIFX effect',
    connected: 'Connection',
    none: 'None',
    other: 'Other effect',
    move: 'Move',
    morph: 'Morph',
    flame: 'Flame',
  },
  fr: {
    light: 'Éclairage',
    brightness: 'Luminosité',
    color: 'Couleur',
    'color-temperature': 'Température de couleur',
    infrared: 'Infrarouge',
    effect: 'Effet LIFX',
    connected: 'Connexion',
    none: 'Aucun',
    other: 'Autre effet',
    move: 'Défilement',
    morph: 'Morphose',
    flame: 'Flamme',
  },
  de: {
    light: 'Licht',
    brightness: 'Helligkeit',
    color: 'Farbe',
    'color-temperature': 'Farbtemperatur',
    infrared: 'Infrarot',
    effect: 'LIFX-Effekt',
    connected: 'Verbindung',
    none: 'Keiner',
    other: 'Anderer Effekt',
    move: 'Lauflicht',
    morph: 'Morph',
    flame: 'Flamme',
  },
  es: {
    light: 'Luz',
    brightness: 'Brillo',
    color: 'Color',
    'color-temperature': 'Temperatura de color',
    infrared: 'Infrarrojo',
    effect: 'Efecto LIFX',
    connected: 'Conexión',
    none: 'Ninguno',
    other: 'Otro efecto',
    move: 'Desplazamiento',
    morph: 'Transformación',
    flame: 'Llama',
  },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

/** External ids of the Gladys device of a LIFX light. */
export const deviceIds = (gladys, serial) => gladys.externalIds(DEVICE_TYPE, serial);

/**
 * Default name: the label given in the LIFX app ("Living room"), else the
 * product and the end of the serial. The user renames it in Gladys anyway.
 */
export function deviceName(record) {
  if (record.label) {
    return record.label;
  }
  const product = record.caps?.product ?? 'LIFX';
  const brand = product.startsWith('LIFX') ? product : `LIFX ${product}`;
  return `${brand} ${record.serial.slice(-6).toUpperCase()}`;
}

/** Options of the effect list: "None", the effects of the device, "Other". */
export function effectOptions(caps, language) {
  const names = namesFor(language);
  return [NO_EFFECT, ...effectsOf(caps), OTHER_EFFECT].map((value, index) => ({
    value,
    label: names[value],
    sort_order: index,
  }));
}

/**
 * Feature specs of a device, in publication order.
 * @param {object} caps capabilitiesOf() of the device
 * @param {string} language
 */
export function featureSpecs(caps, language) {
  const names = namesFor(language);
  const specs = [
    {
      key: FEATURE_KEYS.POWER,
      name: names.light,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.BINARY,
      min: 0,
      max: 1,
      history: true,
    },
    {
      key: FEATURE_KEYS.BRIGHTNESS,
      name: names.brightness,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.BRIGHTNESS,
      unit: UNITS.PERCENT,
      min: 0,
      max: 100,
      history: true,
    },
  ];
  if (caps.color) {
    specs.push({
      key: FEATURE_KEYS.COLOR,
      name: names.color,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.COLOR,
      min: 0,
      max: 0xffffff,
      history: true,
    });
  }
  if (caps.temperature) {
    // In kelvins, the bounds of the model and firmware: the Gladys slider
    // reads the `kelvin` unit as a physical scale (warm on the left).
    specs.push({
      key: FEATURE_KEYS.TEMPERATURE,
      name: names['color-temperature'],
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.TEMPERATURE,
      unit: UNITS.KELVIN,
      min: caps.kelvin.min,
      max: caps.kelvin.max,
      history: true,
    });
  }
  if (caps.infrared) {
    // A slider the dashboard can drive, in % of the infrared power (LIFX
    // Nightvision): a second light/brightness would read as the main one.
    specs.push({
      key: FEATURE_KEYS.INFRARED,
      name: names.infrared,
      category: CATEGORIES.SWITCH,
      type: TYPES.SWITCH.DIMMER,
      min: 0,
      max: 100,
      history: false,
    });
  }
  if (effectsOf(caps).length > 0) {
    // A list the dashboard can drive (light/effect-mode is display-only).
    specs.push({
      key: FEATURE_KEYS.EFFECT,
      name: names.effect,
      category: CATEGORIES.TEXT,
      type: TYPES.TEXT.SELECT,
      min: 0,
      max: 0,
      history: false,
      supported_options: effectOptions(caps, language),
    });
  }
  specs.push({
    key: FEATURE_KEYS.CONNECTED,
    name: names.connected,
    category: CATEGORIES.INPUT,
    type: TYPES.INPUT.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    history: true,
  });
  return specs;
}

/** Discovery payload of one LIFX light. */
export function buildDevice(gladys, record, language) {
  const ids = deviceIds(gladys, record.serial);
  return {
    name: deviceName(record),
    external_id: ids.device,
    model: record.caps.product ?? `LIFX ${record.version?.product ?? '?'}`,
    // The container reads every light itself at the configured pace: the
    // Gladys scheduler cannot be trusted with external devices
    // (GladysAssistant/Gladys#3198).
    should_poll: false,
    params: [
      { name: 'IP_ADDRESS', value: record.host },
      { name: 'SERIAL', value: record.serial },
      { name: 'FIRMWARE', value: record.caps.firmware },
    ],
    features: featureSpecs(record.caps, language).map((spec) => {
      const feature = {
        name: spec.name,
        external_id: ids.feature(spec.key),
        category: spec.category,
        type: spec.type,
        min: spec.min,
        max: spec.max,
        read_only: spec.read_only === true,
        has_feedback: true,
        keep_history: spec.history,
      };
      if (spec.unit) {
        feature.unit = spec.unit;
      }
      if (spec.supported_options) {
        feature.supported_options = spec.supported_options;
      }
      return feature;
    }),
  };
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Feature values of a device, by feature key: numbers, or `{ text }` for the
 * effect list. Only what the last reading told; a light that does not answer
 * is shown off (most often switched off at the wall).
 */
export function deviceValues(record) {
  const { caps } = record;
  const light = record.light ?? null;
  const values = {};
  if (record.reachable !== null) {
    values[FEATURE_KEYS.CONNECTED] = record.reachable ? 1 : 0;
  }
  if (record.reachable === false) {
    values[FEATURE_KEYS.POWER] = 0;
    return values;
  }
  if (!light) {
    return values;
  }
  values[FEATURE_KEYS.POWER] = light.power > 0 ? 1 : 0;
  values[FEATURE_KEYS.BRIGHTNESS] = toPercent(light.brightness);
  const white = !caps.color || isWhite(light);
  if (caps.color && !white) {
    values[FEATURE_KEYS.COLOR] = hsbkToRgbInt(light);
  }
  if (caps.temperature && white && isNumber(light.kelvin) && light.kelvin > 0) {
    values[FEATURE_KEYS.TEMPERATURE] = clamp(light.kelvin, caps.kelvin.min, caps.kelvin.max);
  }
  if (caps.infrared && isNumber(record.infrared)) {
    values[FEATURE_KEYS.INFRARED] = toPercent(record.infrared);
  }
  if (effectsOf(caps).length > 0 && typeof record.effect === 'string') {
    values[FEATURE_KEYS.EFFECT] = { text: record.effect };
  }
  return values;
}
