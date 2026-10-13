// -----------------------------------------------------------------------------
// The LIFX LAN protocol, packet by packet: a 36-byte header (frame, frame
// address, protocol header), then the payload of the message type. Every
// number is little-endian. Layouts from the official description
// (https://lan.developer.lifx.com, machine-readable in LIFX/public-protocol).
//
// Only the messages the integration sends or reads are here. Encoders take
// plain values and return a Buffer; decoders take the payload Buffer and
// return plain values, or throw on a payload too short.
// -----------------------------------------------------------------------------

export const LIFX_PORT = 56700;
export const HEADER_SIZE = 36;
const PROTOCOL = 1024;
const ADDRESSABLE = 0x1000;
const TAGGED = 0x2000;

export const MESSAGES = {
  GET_SERVICE: 2,
  STATE_SERVICE: 3,
  GET_HOST_FIRMWARE: 14,
  STATE_HOST_FIRMWARE: 15,
  GET_VERSION: 32,
  STATE_VERSION: 33,
  ACKNOWLEDGEMENT: 45,
  LIGHT_GET: 101,
  LIGHT_SET_COLOR: 102,
  LIGHT_SET_WAVEFORM: 103,
  LIGHT_STATE: 107,
  LIGHT_SET_POWER: 117,
  LIGHT_SET_WAVEFORM_OPTIONAL: 119,
  LIGHT_GET_INFRARED: 120,
  LIGHT_STATE_INFRARED: 121,
  LIGHT_SET_INFRARED: 122,
  STATE_UNHANDLED: 223,
  SET_COLOR_ZONES: 501,
  GET_COLOR_ZONES: 502,
  STATE_ZONE: 503,
  STATE_MULTI_ZONE: 506,
  GET_MULTI_ZONE_EFFECT: 507,
  SET_MULTI_ZONE_EFFECT: 508,
  STATE_MULTI_ZONE_EFFECT: 509,
  SET_EXTENDED_COLOR_ZONES: 510,
  GET_EXTENDED_COLOR_ZONES: 511,
  STATE_EXTENDED_COLOR_ZONES: 512,
  GET_TILE_EFFECT: 718,
  SET_TILE_EFFECT: 719,
  STATE_TILE_EFFECT: 720,
};

// DeviceService of StateService: the only one a client talks to.
export const SERVICE_UDP = 1;

export const WAVEFORMS = { SAW: 0, SINE: 1, HALF_SINE: 2, TRIANGLE: 3, PULSE: 4 };

export const MULTI_ZONE_EFFECTS = { OFF: 0, MOVE: 1 };
export const TILE_EFFECTS = { OFF: 0, MORPH: 2, FLAME: 3, SKY: 5, COLOR_SWEEP: 6 };

// MultiZoneApplicationRequest: buffer the zones, then apply them all at once.
export const APPLY = { NO_APPLY: 0, APPLY: 1, APPLY_ONLY: 2 };

// Colours per SetExtendedColorZones / StateExtendedColorZones.
export const EXTENDED_ZONES_PER_MESSAGE = 82;
export const TILE_PALETTE_SIZE = 16;

const U16 = 0xffff;

/** A serial (the MAC-like target of a device): 12 lowercase hex digits, or null. */
export function normalizeSerial(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 && hex !== '000000000000' ? hex : null;
}

/**
 * One packet.
 * @param {object} options
 * @param {number} options.type message type (MESSAGES)
 * @param {Buffer} [options.payload]
 * @param {number} options.source client identifier, echoed by the replies
 * @param {number} [options.sequence] 0-255, echoed by the replies
 * @param {string|null} [options.target] serial of the device, null for all
 * @param {boolean} [options.ackRequired]
 * @param {boolean} [options.resRequired]
 */
export function encodePacket({
  type,
  payload = Buffer.alloc(0),
  source,
  sequence = 0,
  target = null,
  ackRequired = false,
  resRequired = false,
}) {
  const packet = Buffer.alloc(HEADER_SIZE + payload.length);
  packet.writeUInt16LE(packet.length, 0);
  // A message to every device (GetService) is "tagged", with no target.
  packet.writeUInt16LE(PROTOCOL | ADDRESSABLE | (target ? 0 : TAGGED), 2);
  packet.writeUInt32LE(source >>> 0, 4);
  if (target) {
    Buffer.from(normalizeSerial(target) ?? '000000000000', 'hex').copy(packet, 8);
  }
  packet.writeUInt8((ackRequired ? 2 : 0) | (resRequired ? 1 : 0), 22);
  packet.writeUInt8(sequence & 0xff, 23);
  packet.writeUInt16LE(type, 32);
  payload.copy(packet, HEADER_SIZE);
  return packet;
}

/**
 * The header and the raw payload of a packet, or null when the datagram is
 * not a LIFX packet (too short, wrong size or protocol).
 * @param {Buffer} data
 */
export function decodePacket(data) {
  if (!Buffer.isBuffer(data) || data.length < HEADER_SIZE) {
    return null;
  }
  const size = data.readUInt16LE(0);
  const flags = data.readUInt16LE(2);
  if (size !== data.length || (flags & 0x0fff) !== PROTOCOL) {
    return null;
  }
  const response = data.readUInt8(22);
  return {
    tagged: (flags & TAGGED) !== 0,
    source: data.readUInt32LE(4),
    target: data.subarray(8, 14).toString('hex'),
    ackRequired: (response & 2) !== 0,
    resRequired: (response & 1) !== 0,
    sequence: data.readUInt8(23),
    type: data.readUInt16LE(32),
    payload: data.subarray(HEADER_SIZE),
  };
}

// --- Payloads --------------------------------------------------------------------

function need(payload, size, name) {
  if (!Buffer.isBuffer(payload) || payload.length < size) {
    throw new RangeError(`${name}: ${payload?.length ?? 0} bytes, ${size} expected`);
  }
}

const clampU16 = (value) => Math.min(U16, Math.max(0, Math.round(Number(value) || 0)));

function writeHsbk(buffer, offset, { hue, saturation, brightness, kelvin }) {
  buffer.writeUInt16LE(clampU16(hue), offset);
  buffer.writeUInt16LE(clampU16(saturation), offset + 2);
  buffer.writeUInt16LE(clampU16(brightness), offset + 4);
  buffer.writeUInt16LE(clampU16(kelvin), offset + 6);
}

function readHsbk(buffer, offset) {
  return {
    hue: buffer.readUInt16LE(offset),
    saturation: buffer.readUInt16LE(offset + 2),
    brightness: buffer.readUInt16LE(offset + 4),
    kelvin: buffer.readUInt16LE(offset + 6),
  };
}

/** Text of a fixed-size label field: UTF-8 up to the first zero byte. */
function readLabel(buffer, offset, size) {
  const raw = buffer.subarray(offset, offset + size);
  const end = raw.indexOf(0);
  return raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString('utf8')
    .replace(/�/g, '')
    .trim();
}

const durationMs = (ms) => Math.min(0xffffffff, Math.max(0, Math.round(Number(ms) || 0)));

export const decode = {
  [MESSAGES.STATE_SERVICE](payload) {
    need(payload, 5, 'StateService');
    return { service: payload.readUInt8(0), port: payload.readUInt32LE(1) };
  },
  [MESSAGES.STATE_HOST_FIRMWARE](payload) {
    need(payload, 20, 'StateHostFirmware');
    return { minor: payload.readUInt16LE(16), major: payload.readUInt16LE(18) };
  },
  [MESSAGES.STATE_VERSION](payload) {
    need(payload, 8, 'StateVersion');
    return { vendor: payload.readUInt32LE(0), product: payload.readUInt32LE(4) };
  },
  [MESSAGES.LIGHT_STATE](payload) {
    need(payload, 44, 'LightState');
    return {
      ...readHsbk(payload, 0),
      power: payload.readUInt16LE(10),
      label: readLabel(payload, 12, 32),
    };
  },
  [MESSAGES.LIGHT_STATE_INFRARED](payload) {
    need(payload, 2, 'StateInfrared');
    return { brightness: payload.readUInt16LE(0) };
  },
  [MESSAGES.STATE_UNHANDLED](payload) {
    need(payload, 2, 'StateUnhandled');
    return { type: payload.readUInt16LE(0) };
  },
  [MESSAGES.STATE_ZONE](payload) {
    need(payload, 10, 'StateZone');
    return { count: payload.readUInt8(0), index: payload.readUInt8(1) };
  },
  [MESSAGES.STATE_MULTI_ZONE](payload) {
    need(payload, 2, 'StateMultiZone');
    return { count: payload.readUInt8(0), index: payload.readUInt8(1) };
  },
  [MESSAGES.STATE_EXTENDED_COLOR_ZONES](payload) {
    need(payload, 5, 'StateExtendedColorZones');
    return { count: payload.readUInt16LE(0), index: payload.readUInt16LE(2) };
  },
  [MESSAGES.STATE_MULTI_ZONE_EFFECT](payload) {
    need(payload, 59, 'StateMultiZoneEffect');
    return {
      type: payload.readUInt8(4),
      speed: payload.readUInt32LE(7),
      direction: payload.readUInt32LE(31),
    };
  },
  [MESSAGES.STATE_TILE_EFFECT](payload) {
    need(payload, 187, 'StateTileEffect');
    // One reserved byte, then the effect settings.
    return { type: payload.readUInt8(5), speed: payload.readUInt32LE(6) };
  },
};

export const encode = {
  /** SetColor: the whole HSBK, with a transition in ms. */
  setColor({ color, duration = 0 }) {
    const payload = Buffer.alloc(13);
    writeHsbk(payload, 1, color);
    payload.writeUInt32LE(durationMs(duration), 9);
    return payload;
  },

  /**
   * SetWaveformOptional: only the components flagged in `set` change (the
   * Home Assistant way to write a colour: a half sine, once, not transient).
   */
  setWaveformOptional({ color, period = 0, cycles = 1, skew = 0, waveform, transient, set }) {
    const payload = Buffer.alloc(25);
    payload.writeUInt8(transient ? 1 : 0, 1);
    writeHsbk(payload, 2, color);
    payload.writeUInt32LE(durationMs(period), 10);
    payload.writeFloatLE(cycles, 14);
    payload.writeInt16LE(skew, 18);
    payload.writeUInt8(waveform, 20);
    payload.writeUInt8(set.hue ? 1 : 0, 21);
    payload.writeUInt8(set.saturation ? 1 : 0, 22);
    payload.writeUInt8(set.brightness ? 1 : 0, 23);
    payload.writeUInt8(set.kelvin ? 1 : 0, 24);
    return payload;
  },

  /** SetWaveform: a whole HSBK target, `cycles` times `period` ms. */
  setWaveform({ color, period, cycles, skew = 0, waveform, transient }) {
    const payload = Buffer.alloc(21);
    payload.writeUInt8(transient ? 1 : 0, 1);
    writeHsbk(payload, 2, color);
    payload.writeUInt32LE(durationMs(period), 10);
    payload.writeFloatLE(cycles, 14);
    payload.writeInt16LE(skew, 18);
    payload.writeUInt8(waveform, 20);
    return payload;
  },

  /** SetLightPower: on (65535) or off (0), with a transition in ms. */
  setLightPower({ on, duration = 0 }) {
    const payload = Buffer.alloc(6);
    payload.writeUInt16LE(on ? U16 : 0, 0);
    payload.writeUInt32LE(durationMs(duration), 2);
    return payload;
  },

  setInfrared({ brightness }) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16LE(clampU16(brightness), 0);
    return payload;
  },

  /** GetColorZones: the legacy messages, every zone (0-255). */
  getColorZones({ start = 0, end = 255 } = {}) {
    return Buffer.from([start & 0xff, end & 0xff]);
  },

  setColorZones({ start, end, color, duration = 0, apply }) {
    const payload = Buffer.alloc(15);
    payload.writeUInt8(start & 0xff, 0);
    payload.writeUInt8(end & 0xff, 1);
    writeHsbk(payload, 2, color);
    payload.writeUInt32LE(durationMs(duration), 10);
    payload.writeUInt8(apply, 14);
    return payload;
  },

  /** SetExtendedColorZones: up to 82 zones from `index`. */
  setExtendedColorZones({ index, colors, duration = 0, apply }) {
    const count = Math.min(colors.length, EXTENDED_ZONES_PER_MESSAGE);
    const payload = Buffer.alloc(8 + EXTENDED_ZONES_PER_MESSAGE * 8);
    payload.writeUInt32LE(durationMs(duration), 0);
    payload.writeUInt8(apply, 4);
    payload.writeUInt16LE(index, 5);
    payload.writeUInt8(count, 7);
    for (let at = 0; at < count; at += 1) {
      writeHsbk(payload, 8 + at * 8, colors[at]);
    }
    return payload;
  },

  /** SetMultiZoneEffect: `type` MOVE or OFF; speed in ms per cycle. */
  setMultiZoneEffect({ instanceId, type, speed = 0, direction = 0 }) {
    const payload = Buffer.alloc(59);
    payload.writeUInt32LE(instanceId >>> 0, 0);
    payload.writeUInt8(type, 4);
    payload.writeUInt32LE(durationMs(speed), 7);
    // Duration 0 (bytes 11-18): until stopped. Parameter1 is the direction.
    payload.writeUInt32LE(direction, 31);
    return payload;
  },

  /** GetTileEffect: two reserved bytes. */
  getTileEffect() {
    return Buffer.alloc(2);
  },

  /** SetTileEffect: MORPH, FLAME or OFF, with up to 16 palette colours. */
  setTileEffect({ instanceId, type, speed = 0, palette = [] }) {
    const payload = Buffer.alloc(188);
    payload.writeUInt32LE(instanceId >>> 0, 2);
    payload.writeUInt8(type, 6);
    payload.writeUInt32LE(durationMs(speed), 7);
    // Duration 0 (bytes 11-18): until stopped. The parameters (sky type,
    // cloud saturation) stay at zero: they only concern the Sky effect.
    const colors = palette.slice(0, TILE_PALETTE_SIZE);
    payload.writeUInt8(colors.length, 59);
    colors.forEach((color, at) => writeHsbk(payload, 60 + at * 8, color));
    return payload;
  },
};
