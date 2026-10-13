// -----------------------------------------------------------------------------
// The UDP client against a fake light on a real socket: replies, retries
// after a lost datagram, timeouts, StateUnhandled, foreign datagrams.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { MESSAGES, encode, encodePacket } from '../src/lifx/packet.js';
import { LifxTransport } from '../src/lifx/transport.js';
import { FAKE_TYPES, FakeLifx } from './helpers/fakeLifx.js';
import { FAST_TRANSPORT } from './helpers/world.js';

async function setup(t, fixture = 'a19-color-pid27-fw2.80') {
  const light = await new FakeLifx(fixture).listen();
  const transport = new LifxTransport({ timings: FAST_TRANSPORT });
  t.after(() => {
    transport.close();
    light.close();
  });
  const target = { host: light.host, port: light.port, serial: light.serial };
  return { light, transport, target };
}

test('a Get is answered by its State, decoded', async (t) => {
  const { transport, target } = await setup(t);
  const reply = await transport.request(target, MESSAGES.LIGHT_GET, {
    expect: [MESSAGES.LIGHT_STATE],
  });
  assert.equal(reply.target, 'd073d5000001');
  assert.deepEqual(reply.data, {
    hue: 21845,
    saturation: 65535,
    brightness: 32768,
    kelvin: 3500,
    power: 65535,
    label: 'Salon',
  });
});

test('a Set waits for its acknowledgement, and the light applies it', async (t) => {
  const { light, transport, target } = await setup(t);
  await transport.command(target, MESSAGES.LIGHT_SET_POWER, encode.setLightPower({ on: false }));
  assert.equal(light.power, 0);
  const [request] = light.sent(FAKE_TYPES.SET_LIGHT_POWER);
  assert.equal(request.header.ack, true);
  assert.equal(request.header.target, light.serial);
  assert.equal(request.header.tagged, false);
});

test('a lost datagram is sent again, with the same sequence number', async (t) => {
  const { light, transport, target } = await setup(t);
  light.drop = 2;
  const reply = await transport.request(target, MESSAGES.GET_VERSION, {
    expect: [MESSAGES.STATE_VERSION],
  });
  assert.deepEqual(reply.data, { vendor: 1, product: 27 });
  const sent = light.sent(FAKE_TYPES.GET_VERSION);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((request) => request.header.sequence)).size, 1);
});

test('a light that does not answer is unreachable', async (t) => {
  const { light, transport, target } = await setup(t);
  light.online = false;
  await assert.rejects(
    transport.request(target, MESSAGES.LIGHT_GET, { expect: [MESSAGES.LIGHT_STATE] }),
    (err) => err.name === 'LifxError' && err.kind === 'timeout' && err.unreachable,
  );
});

test('StateUnhandled: an older firmware without the message', async (t) => {
  const { transport, target } = await setup(t, 'original-pid1-fw1.5');
  await assert.rejects(
    transport.command(
      target,
      MESSAGES.LIGHT_SET_WAVEFORM_OPTIONAL,
      encode.setWaveformOptional({
        color: { hue: 0, saturation: 0, brightness: 0, kelvin: 3500 },
        waveform: 2,
        transient: false,
        set: { brightness: true },
      }),
    ),
    (err) => err.kind === 'unhandled' && !err.unreachable,
  );
});

test('one request at a time per light, in order', async (t) => {
  const { light, transport, target } = await setup(t);
  await Promise.all([
    transport.command(target, MESSAGES.LIGHT_SET_POWER, encode.setLightPower({ on: false })),
    transport.request(target, MESSAGES.LIGHT_GET, { expect: [MESSAGES.LIGHT_STATE] }),
    transport.command(target, MESSAGES.LIGHT_SET_POWER, encode.setLightPower({ on: true })),
  ]);
  assert.deepEqual(
    light.received.map((request) => request.type),
    [FAKE_TYPES.SET_LIGHT_POWER, FAKE_TYPES.LIGHT_GET, FAKE_TYPES.SET_LIGHT_POWER],
  );
  assert.equal(light.power, 65535);
});

test('replies to another client, or garbage, are ignored', async (t) => {
  const { transport, target, light } = await setup(t);
  await transport.open();
  const { port } = transport.socket.address();
  // A stranger sends a well-formed LightState with another source to our port.
  const intruder = dgram.createSocket('udp4');
  t.after(() => intruder.close());
  const forged = encodePacket({
    type: MESSAGES.LIGHT_STATE,
    source: transport.source + 1,
    sequence: (transport.sequence + 1) & 0xff,
    payload: Buffer.alloc(52),
  });
  light.drop = 1;
  const pending = transport.request(target, MESSAGES.LIGHT_GET, {
    expect: [MESSAGES.LIGHT_STATE],
  });
  await new Promise((resolve) => intruder.send(forged, port, '127.0.0.1', resolve));
  await new Promise((resolve) =>
    intruder.send(Buffer.from('not lifx'), port, '127.0.0.1', resolve),
  );
  const reply = await pending;
  assert.equal(reply.data.label, 'Salon', 'the real reply, after a retry');
});

test('a closed transport refuses new requests', async (t) => {
  const { transport, target } = await setup(t);
  transport.close();
  await assert.rejects(
    transport.request(target, MESSAGES.LIGHT_GET, { expect: [MESSAGES.LIGHT_STATE] }),
    /stopping/,
  );
});
