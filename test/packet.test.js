// -----------------------------------------------------------------------------
// The LIFX packets, byte by byte: the header of the official "building a LIFX
// packet" example, the payload sizes of LIFX/public-protocol (protocol.yml),
// and the decoding of the State messages.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY,
  HEADER_SIZE,
  MESSAGES,
  TILE_EFFECTS,
  WAVEFORMS,
  decode,
  decodePacket,
  encode,
  encodePacket,
  normalizeSerial,
} from '../src/lifx/packet.js';

const hex = (buffer) => buffer.toString('hex').replace(/(..)/g, '$1 ').trim().toUpperCase();

test('the SetColor example of the LIFX documentation, to the byte', () => {
  // "Building a LIFX packet": SetColor to green (hue 120°), full saturation
  // and brightness, 3500 K, over 1024 ms, to every device, source 0.
  const packet = encodePacket({
    type: MESSAGES.LIGHT_SET_COLOR,
    source: 0,
    payload: encode.setColor({
      color: { hue: 21845, saturation: 65535, brightness: 65535, kelvin: 3500 },
      duration: 1024,
    }),
  });
  assert.equal(
    hex(packet),
    '31 00 00 34 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 66 00 00 00 00 55 55 FF FF FF FF AC 0D 00 04 00 00',
  );
});

test('a message to one light carries its serial, untagged, with the response flags', () => {
  const packet = encodePacket({
    type: MESSAGES.LIGHT_GET,
    source: 0x12345678,
    sequence: 0x2a,
    target: 'D0:73:D5:00:00:01',
    resRequired: true,
  });
  assert.equal(packet.length, HEADER_SIZE);
  assert.equal(packet.readUInt16LE(2), 0x1400, 'protocol 1024, addressable, not tagged');
  assert.equal(packet.readUInt32LE(4), 0x12345678);
  assert.equal(packet.subarray(8, 16).toString('hex'), 'd073d50000010000');
  assert.equal(packet.readUInt8(22), 1, 'res_required');
  assert.equal(packet.readUInt8(23), 0x2a);
  assert.equal(packet.readUInt16LE(32), 101);

  const ack = encodePacket({ type: MESSAGES.LIGHT_SET_POWER, source: 1, ackRequired: true });
  assert.equal(ack.readUInt8(22), 2, 'ack_required');

  assert.deepEqual(decodePacket(packet), {
    tagged: false,
    source: 0x12345678,
    target: 'd073d5000001',
    ackRequired: false,
    resRequired: true,
    sequence: 0x2a,
    type: 101,
    payload: Buffer.alloc(0),
  });
});

test('datagrams that are not LIFX packets are refused', () => {
  assert.equal(decodePacket(Buffer.from('{"method":"getPilot"}')), null);
  const packet = encodePacket({ type: MESSAGES.GET_SERVICE, source: 1 });
  assert.equal(decodePacket(packet.subarray(0, 30)), null, 'too short');
  const wrongSize = Buffer.from(packet);
  wrongSize.writeUInt16LE(40, 0);
  assert.equal(decodePacket(wrongSize), null, 'size field does not match');
  const wrongProtocol = Buffer.from(packet);
  wrongProtocol.writeUInt16LE(0x3401, 2);
  assert.equal(decodePacket(wrongProtocol), null, 'protocol other than 1024');
});

test('payload sizes are the ones of the protocol description', () => {
  const color = { hue: 1, saturation: 2, brightness: 3, kelvin: 3500 };
  const sizes = {
    SetColor: [encode.setColor({ color }), 13],
    SetWaveform: [
      encode.setWaveform({ color, period: 1, cycles: 1, waveform: 0, transient: true }),
      21,
    ],
    SetWaveformOptional: [
      encode.setWaveformOptional({ color, waveform: 2, transient: false, set: {} }),
      25,
    ],
    SetLightPower: [encode.setLightPower({ on: true }), 6],
    SetInfrared: [encode.setInfrared({ brightness: 1 }), 2],
    GetColorZones: [encode.getColorZones(), 2],
    SetColorZones: [encode.setColorZones({ start: 0, end: 1, color, apply: 1 }), 15],
    SetExtendedColorZones: [
      encode.setExtendedColorZones({ index: 0, colors: [color], apply: 1 }),
      664,
    ],
    SetMultiZoneEffect: [encode.setMultiZoneEffect({ instanceId: 1, type: 1 }), 59],
    GetTileEffect: [encode.getTileEffect(), 2],
    SetTileEffect: [encode.setTileEffect({ instanceId: 1, type: 2 }), 188],
  };
  for (const [name, [payload, size]] of Object.entries(sizes)) {
    assert.equal(payload.length, size, name);
  }
});

test('the fields land at their offsets', () => {
  const color = { hue: 0x1111, saturation: 0x2222, brightness: 0x3333, kelvin: 0x0dac };
  const waveform = encode.setWaveformOptional({
    color,
    period: 500,
    cycles: 2.5,
    skew: -100,
    waveform: WAVEFORMS.HALF_SINE,
    transient: true,
    set: { hue: true, brightness: true },
  });
  assert.equal(waveform.readUInt8(1), 1);
  assert.equal(waveform.readUInt16LE(2), 0x1111);
  assert.equal(waveform.readUInt16LE(8), 0x0dac);
  assert.equal(waveform.readUInt32LE(10), 500);
  assert.equal(waveform.readFloatLE(14), 2.5);
  assert.equal(waveform.readInt16LE(18), -100);
  assert.equal(waveform.readUInt8(20), 2);
  assert.deepEqual([...waveform.subarray(21, 25)], [1, 0, 1, 0]);

  const power = encode.setLightPower({ on: true, duration: 2000 });
  assert.equal(power.readUInt16LE(0), 65535);
  assert.equal(power.readUInt32LE(2), 2000);
  assert.equal(encode.setLightPower({ on: false }).readUInt16LE(0), 0);

  const move = encode.setMultiZoneEffect({ instanceId: 7, type: 1, speed: 3000, direction: 1 });
  assert.equal(move.readUInt32LE(0), 7);
  assert.equal(move.readUInt8(4), 1);
  assert.equal(move.readUInt32LE(7), 3000);
  assert.equal(move.readBigUInt64LE(11), 0n, 'runs until stopped');
  assert.equal(move.readUInt32LE(31), 1, 'parameter 1: the direction');

  const palette = [color, { ...color, hue: 0x4444 }];
  const morph = encode.setTileEffect({
    instanceId: 9,
    type: TILE_EFFECTS.MORPH,
    speed: 1000,
    palette,
  });
  assert.equal(morph.readUInt32LE(2), 9);
  assert.equal(morph.readUInt8(6), 2);
  assert.equal(morph.readUInt32LE(7), 1000);
  assert.equal(morph.readUInt8(59), 2, 'palette count');
  assert.equal(morph.readUInt16LE(60 + 8), 0x4444, 'second palette colour');

  const zones = encode.setExtendedColorZones({
    index: 82,
    colors: [color, color, color],
    duration: 0,
    apply: APPLY.APPLY,
  });
  assert.equal(zones.readUInt8(4), 1);
  assert.equal(zones.readUInt16LE(5), 82);
  assert.equal(zones.readUInt8(7), 3);
  assert.equal(zones.readUInt16LE(8 + 2 * 8 + 6), 0x0dac);
});

test('the State messages decode', () => {
  const service = Buffer.alloc(5);
  service.writeUInt8(1, 0);
  service.writeUInt32LE(56700, 1);
  assert.deepEqual(decode[MESSAGES.STATE_SERVICE](service), { service: 1, port: 56700 });

  const firmware = Buffer.alloc(20);
  firmware.writeUInt16LE(80, 16);
  firmware.writeUInt16LE(2, 18);
  assert.deepEqual(decode[MESSAGES.STATE_HOST_FIRMWARE](firmware), { major: 2, minor: 80 });

  const version = Buffer.alloc(12);
  version.writeUInt32LE(1, 0);
  version.writeUInt32LE(27, 4);
  assert.deepEqual(decode[MESSAGES.STATE_VERSION](version), { vendor: 1, product: 27 });

  const state = Buffer.alloc(52);
  state.writeUInt16LE(21845, 0);
  state.writeUInt16LE(65535, 2);
  state.writeUInt16LE(32768, 4);
  state.writeUInt16LE(3500, 6);
  state.writeUInt16LE(65535, 10);
  Buffer.from('Séjour', 'utf8').copy(state, 12);
  assert.deepEqual(decode[MESSAGES.LIGHT_STATE](state), {
    hue: 21845,
    saturation: 65535,
    brightness: 32768,
    kelvin: 3500,
    power: 65535,
    label: 'Séjour',
  });

  const effect = Buffer.alloc(187);
  effect.writeUInt8(3, 5);
  assert.equal(decode[MESSAGES.STATE_TILE_EFFECT](effect).type, 3);
  const move = Buffer.alloc(59);
  move.writeUInt8(1, 4);
  assert.equal(decode[MESSAGES.STATE_MULTI_ZONE_EFFECT](move).type, 1);

  assert.throws(() => decode[MESSAGES.LIGHT_STATE](Buffer.alloc(10)), /LightState/);
});

test('serials are 12 hex digits, never all zeros', () => {
  assert.equal(normalizeSerial('D0:73:D5:00:00:01'), 'd073d5000001');
  assert.equal(normalizeSerial('d073d5000001'), 'd073d5000001');
  assert.equal(normalizeSerial('000000000000'), null);
  assert.equal(normalizeSerial('d073d5'), null);
  assert.equal(normalizeSerial(42), null);
});
