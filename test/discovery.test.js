import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, parseScanReplies, scanRequest } from '../src/discovery.js';
import { decodePacket } from '../src/lifx/packet.js';
import { FakeLifx } from './helpers/fakeLifx.js';

test('the scan request is a tagged GetService on port 56700, within the core bounds', () => {
  const request = scanRequest(1234);
  assert.equal(request.port, 56700);
  assert.ok(request.payload.length <= 512, 'the core refuses a payload over 512 bytes');
  assert.ok(request.timeoutSeconds >= 1 && request.timeoutSeconds <= 30);
  const packet = decodePacket(request.payload);
  assert.equal(packet.type, 2);
  assert.equal(packet.tagged, true);
  assert.equal(packet.source, 1234);
  assert.equal(packet.target, '000000000000');
});

test('scan replies: one light per serial, the UDP service only, garbage ignored', async (t) => {
  const light = await new FakeLifx('a19-color-pid27-fw2.80').listen();
  const strip = await new FakeLifx('z-strip-pid32-fw2.77').listen();
  t.after(() => {
    light.close();
    strip.close();
  });
  const replies = [
    ...light.scanReplies(),
    ...light.scanReplies(),
    ...strip.scanReplies(),
    { source_ip: '192.0.2.99', source_port: 56700, payload_base64: 'bm90IGxpZng=' },
    { source_ip: 'not an address', payload_base64: light.scanReplies()[1].payload_base64 },
    null,
  ];
  assert.deepEqual(parseScanReplies(replies), [
    { host: '127.0.0.1', port: light.port, serial: 'd073d5000001' },
    { host: '127.0.0.1', port: strip.port, serial: 'd073d5000006' },
  ]);
  assert.deepEqual(parseScanReplies('nothing'), []);
});

test('mapLimit keeps the order and the errors', async () => {
  const results = await mapLimit([1, 2, 3], 2, async (value) => {
    if (value === 2) {
      throw new Error('two');
    }
    return value * 10;
  });
  assert.deepEqual(results[0], { value: 10 });
  assert.equal(results[1].error.message, 'two');
  assert.deepEqual(results[2], { value: 30 });
});
