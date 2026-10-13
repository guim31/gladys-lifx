// -----------------------------------------------------------------------------
// A fake LIFX light on real UDP: it binds a socket on 127.0.0.1 and answers
// the LIFX packets like a device does (StateService, StateVersion, LightState,
// Acknowledgement, StateUnhandled...), from a fixture of test/fixtures/lifx.
//
// It reads the requests with its own offsets, written from the protocol
// description (LIFX/public-protocol protocol.yml), not with src/lifx/packet.js:
// a wrong layout in the integration's encoders shows as a wrong state here.
// It can lose datagrams, go offline, and leave messages "unhandled" like an
// older firmware.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { readFileSync, readdirSync } from 'node:fs';

const FIXTURES = new URL('../fixtures/lifx/', import.meta.url);

/** Every fixture, by file name without `.json`. */
export const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort();

export function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
}

const T = {
  GET_SERVICE: 2,
  STATE_SERVICE: 3,
  GET_HOST_FIRMWARE: 14,
  STATE_HOST_FIRMWARE: 15,
  GET_VERSION: 32,
  STATE_VERSION: 33,
  ACK: 45,
  LIGHT_GET: 101,
  SET_COLOR: 102,
  SET_WAVEFORM: 103,
  LIGHT_STATE: 107,
  SET_LIGHT_POWER: 117,
  SET_WAVEFORM_OPTIONAL: 119,
  GET_INFRARED: 120,
  STATE_INFRARED: 121,
  SET_INFRARED: 122,
  UNHANDLED: 223,
  SET_COLOR_ZONES: 501,
  GET_COLOR_ZONES: 502,
  STATE_MULTI_ZONE: 506,
  GET_MZ_EFFECT: 507,
  SET_MZ_EFFECT: 508,
  STATE_MZ_EFFECT: 509,
  SET_EXT_ZONES: 510,
  GET_EXT_ZONES: 511,
  STATE_EXT_ZONES: 512,
  GET_TILE_EFFECT: 718,
  SET_TILE_EFFECT: 719,
  STATE_TILE_EFFECT: 720,
};
export { T as FAKE_TYPES };

const readHsbk = (buffer, at) => ({
  hue: buffer.readUInt16LE(at),
  saturation: buffer.readUInt16LE(at + 2),
  brightness: buffer.readUInt16LE(at + 4),
  kelvin: buffer.readUInt16LE(at + 6),
});

const writeHsbk = (buffer, at, color) => {
  buffer.writeUInt16LE(color.hue, at);
  buffer.writeUInt16LE(color.saturation, at + 2);
  buffer.writeUInt16LE(color.brightness, at + 4);
  buffer.writeUInt16LE(color.kelvin, at + 6);
};

export class FakeLifx {
  /**
   * @param {string} fixture name of a fixture file
   */
  constructor(fixture) {
    this.fixture = fixture;
    const data = loadFixture(fixture);
    this.data = data;
    this.serial = data.serial;
    this.host = '127.0.0.1';
    this.port = null;
    this.label = data.label ?? '';
    this.color = { ...data.color };
    this.power = data.power ?? 0;
    this.infrared = data.infrared ?? 0;
    this.zoneCount = data.zones ?? 0;
    this.zones = Array.from({ length: this.zoneCount }, () => ({ ...this.color }));
    this.effect = data.effect ?? 0;
    this.unhandled = new Set(data.unhandled ?? []);
    this.online = true;
    // Datagrams to drop before answering again (UDP loss).
    this.drop = 0;
    /** @type {Array<{ type: number, payload: Buffer, header: object }>} */
    this.received = [];
    this.socket = null;
  }

  /** Bind on 127.0.0.1, an ephemeral port (tools/fake-lifx.mjs: the LAN, 56700). */
  listen({ port = 0, address = '127.0.0.1' } = {}) {
    return new Promise((resolve) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('message', (message, remote) => {
        for (const reply of this.handle(message)) {
          this.socket.send(reply, remote.port, remote.address);
        }
      });
      this.socket.bind(port, address, () => {
        this.port = this.socket.address().port;
        if (address !== '127.0.0.1') {
          this.host = address;
        }
        resolve(this);
      });
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }

  /** Requests of a type the light received. */
  sent(type) {
    return this.received.filter((request) => request.type === type);
  }

  reply(header, type, payload = Buffer.alloc(0)) {
    const packet = Buffer.alloc(36 + payload.length);
    packet.writeUInt16LE(packet.length, 0);
    packet.writeUInt16LE(0x1400, 2); // protocol 1024, addressable
    packet.writeUInt32LE(header.source, 4);
    Buffer.from(this.serial, 'hex').copy(packet, 8);
    packet.writeUInt8(header.sequence, 23);
    packet.writeUInt16LE(type, 32);
    payload.copy(packet, 36);
    return packet;
  }

  /** The replies to one datagram (an empty list for no reply). */
  handle(message) {
    if (message.length < 36 || message.readUInt16LE(0) !== message.length) {
      return [];
    }
    const flags = message.readUInt16LE(2);
    const header = {
      tagged: (flags & 0x2000) !== 0,
      source: message.readUInt32LE(4),
      target: message.subarray(8, 14).toString('hex'),
      ack: (message.readUInt8(22) & 2) !== 0,
      sequence: message.readUInt8(23),
    };
    const type = message.readUInt16LE(32);
    const payload = message.subarray(36);
    this.received.push({ type, payload, header });
    if (!this.online) {
      return [];
    }
    if (this.drop > 0) {
      this.drop -= 1;
      return [];
    }
    if (!header.tagged && header.target !== this.serial) {
      return [];
    }
    if (this.unhandled.has(type)) {
      const body = Buffer.alloc(2);
      body.writeUInt16LE(type, 0);
      return [this.reply(header, T.UNHANDLED, body)];
    }
    const ack = () => (header.ack ? [this.reply(header, T.ACK)] : []);
    switch (type) {
      case T.GET_SERVICE: {
        // One reply per service: the UDP one, and a reserved one.
        const udp = Buffer.alloc(5);
        udp.writeUInt8(1, 0);
        udp.writeUInt32LE(this.port, 1);
        const other = Buffer.alloc(5);
        other.writeUInt8(5, 0);
        other.writeUInt32LE(56700, 1);
        return [
          this.reply(header, T.STATE_SERVICE, other),
          this.reply(header, T.STATE_SERVICE, udp),
        ];
      }
      case T.GET_HOST_FIRMWARE: {
        const body = Buffer.alloc(20);
        body.writeUInt16LE(this.data.firmware.minor, 16);
        body.writeUInt16LE(this.data.firmware.major, 18);
        return [this.reply(header, T.STATE_HOST_FIRMWARE, body)];
      }
      case T.GET_VERSION: {
        const body = Buffer.alloc(12);
        body.writeUInt32LE(this.data.vendor ?? 1, 0);
        body.writeUInt32LE(this.data.product, 4);
        return [this.reply(header, T.STATE_VERSION, body)];
      }
      case T.LIGHT_GET:
        return [this.reply(header, T.LIGHT_STATE, this.lightState())];
      case T.SET_COLOR:
        this.color = readHsbk(payload, 1);
        this.zones = this.zones.map(() => ({ ...this.color }));
        this.lastDuration = payload.readUInt32LE(9);
        return ack();
      case T.SET_WAVEFORM: {
        const transient = payload.readUInt8(1) !== 0;
        this.lastWaveform = {
          transient,
          color: readHsbk(payload, 2),
          period: payload.readUInt32LE(10),
          cycles: payload.readFloatLE(14),
          skew: payload.readInt16LE(18),
          waveform: payload.readUInt8(20),
        };
        if (!transient) {
          this.color = this.lastWaveform.color;
        }
        return ack();
      }
      case T.SET_WAVEFORM_OPTIONAL: {
        const color = readHsbk(payload, 2);
        const set = {
          hue: payload.readUInt8(21) !== 0,
          saturation: payload.readUInt8(22) !== 0,
          brightness: payload.readUInt8(23) !== 0,
          kelvin: payload.readUInt8(24) !== 0,
        };
        this.lastWaveformOptional = {
          set,
          period: payload.readUInt32LE(10),
          cycles: payload.readFloatLE(14),
          waveform: payload.readUInt8(20),
          transient: payload.readUInt8(1) !== 0,
        };
        for (const key of Object.keys(set)) {
          if (set[key]) {
            this.color[key] = color[key];
          }
        }
        return ack();
      }
      case T.SET_LIGHT_POWER:
        this.power = payload.readUInt16LE(0);
        this.lastPowerDuration = payload.readUInt32LE(2);
        return ack();
      case T.GET_INFRARED: {
        const body = Buffer.alloc(2);
        body.writeUInt16LE(this.infrared, 0);
        return [this.reply(header, T.STATE_INFRARED, body)];
      }
      case T.SET_INFRARED:
        this.infrared = payload.readUInt16LE(0);
        return ack();
      case T.GET_COLOR_ZONES: {
        // Legacy strips: one StateMultiZone per 8 zones.
        const replies = [];
        for (let index = 0; index < this.zoneCount; index += 8) {
          const body = Buffer.alloc(66);
          body.writeUInt8(this.zoneCount, 0);
          body.writeUInt8(index, 1);
          for (let at = 0; at < 8 && index + at < this.zoneCount; at += 1) {
            writeHsbk(body, 2 + at * 8, this.zones[index + at]);
          }
          replies.push(this.reply(header, T.STATE_MULTI_ZONE, body));
        }
        return replies;
      }
      case T.SET_COLOR_ZONES: {
        const start = payload.readUInt8(0);
        const end = payload.readUInt8(1);
        const color = readHsbk(payload, 2);
        for (let index = start; index <= end && index < this.zoneCount; index += 1) {
          this.zones[index] = color;
        }
        return ack();
      }
      case T.GET_EXT_ZONES: {
        const body = Buffer.alloc(661);
        body.writeUInt16LE(this.zoneCount, 0);
        body.writeUInt16LE(0, 2);
        body.writeUInt8(Math.min(this.zoneCount, 82), 4);
        return [this.reply(header, T.STATE_EXT_ZONES, body)];
      }
      case T.SET_EXT_ZONES: {
        const index = payload.readUInt16LE(5);
        const count = payload.readUInt8(7);
        for (let at = 0; at < count && index + at < this.zoneCount; at += 1) {
          this.zones[index + at] = readHsbk(payload, 8 + at * 8);
        }
        this.lastApply = payload.readUInt8(4);
        return ack();
      }
      case T.GET_MZ_EFFECT: {
        const body = Buffer.alloc(59);
        body.writeUInt8(this.effect, 4);
        return [this.reply(header, T.STATE_MZ_EFFECT, body)];
      }
      case T.SET_MZ_EFFECT:
        this.effect = payload.readUInt8(4);
        this.lastEffect = {
          type: this.effect,
          speed: payload.readUInt32LE(7),
          direction: payload.readUInt32LE(31),
        };
        return ack();
      case T.GET_TILE_EFFECT: {
        const body = Buffer.alloc(187);
        body.writeUInt8(this.effect, 5);
        return [this.reply(header, T.STATE_TILE_EFFECT, body)];
      }
      case T.SET_TILE_EFFECT: {
        this.effect = payload.readUInt8(6);
        const paletteCount = payload.readUInt8(59);
        this.lastEffect = {
          type: this.effect,
          speed: payload.readUInt32LE(7),
          palette: Array.from({ length: paletteCount }, (_, at) => readHsbk(payload, 60 + at * 8)),
        };
        return ack();
      }
      default: {
        const body = Buffer.alloc(2);
        body.writeUInt16LE(type, 0);
        return [this.reply(header, T.UNHANDLED, body)];
      }
    }
  }

  lightState() {
    const body = Buffer.alloc(52);
    writeHsbk(body, 0, this.color);
    body.writeUInt16LE(this.power, 10);
    Buffer.from(this.label, 'utf8').subarray(0, 32).copy(body, 12);
    return body;
  }

  /** The reply to the discovery broadcast, as the Gladys core relays it. */
  scanReplies() {
    if (!this.online) {
      return [];
    }
    const request = Buffer.alloc(36);
    request.writeUInt16LE(36, 0);
    request.writeUInt16LE(0x3400, 2);
    request.writeUInt32LE(4242, 4);
    request.writeUInt16LE(T.GET_SERVICE, 32);
    return this.handle(request).map((reply) => ({
      source_ip: this.host,
      source_port: this.port,
      payload_base64: reply.toString('base64'),
    }));
  }
}

/** Start one fake light per fixture name. */
export async function startLights(names) {
  return Promise.all(names.map((name) => new FakeLifx(name).listen()));
}
