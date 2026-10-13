#!/usr/bin/env node
// -----------------------------------------------------------------------------
// A fake LIFX light on the LAN, to try the integration on a real Gladys
// without the hardware: it answers the discovery broadcast and the LIFX
// packets on UDP port 56700, like a bulb would, from one of the fixtures of
// test/fixtures/lifx.
//
//   node tools/fake-lifx.mjs                        # a colour bulb (A19)
//   node tools/fake-lifx.mjs z-strip-pid32-fw2.77   # a LIFX Z strip
//
// Run it on another machine of the network than Gladys (port 56700 must be
// free), then "Search for LIFX lights" in the integration. Every request it
// receives is printed. Development tool: the image never runs it.
// -----------------------------------------------------------------------------

import { FIXTURE_NAMES, FakeLifx } from '../test/helpers/fakeLifx.js';

const fixture = process.argv[2] ?? 'a19-color-pid27-fw2.80';
if (!FIXTURE_NAMES.includes(fixture)) {
  console.error(`Unknown fixture "${fixture}". Known: ${FIXTURE_NAMES.join(', ')}`);
  process.exit(1);
}

const light = new FakeLifx(fixture);
const handle = light.handle.bind(light);
light.handle = (message) => {
  const replies = handle(message);
  const request = light.received.at(-1);
  if (request) {
    console.log(
      `message ${request.type} (sequence ${request.header.sequence}) → ${replies.length} reply(ies);` +
        ` power ${light.power}, colour ${JSON.stringify(light.color)}`,
    );
  }
  return replies;
};
await light.listen({ port: 56700, address: '0.0.0.0' });
console.log(`Fake LIFX "${light.label}" (${fixture}, serial ${light.serial}) on UDP 56700`);
