# LIFX for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[LIFX](https://www.lifx.com) lights: bulbs, strips (Z, Beam, Neon, String...)
and matrices (Tile, Candle, Ceiling...), driven over the local network with the
official LIFX LAN protocol. No account, no cloud, no key.

> **Developed without the hardware: feedback welcome.** Everything was built
> from the public LIFX protocol description and tested against simulated
> lights answering real UDP packets, not against a real LIFX light. Please
> report what works and what does not on the
> [Gladys forum](https://community.gladysassistant.com) or in the
> [issues](https://github.com/guim31/gladys-lifx/issues).

Not affiliated with LIFX: LIFX is a trademark of its owner.

## Features

- **Automatic discovery**: Gladys broadcasts the LIFX `GetService` request on
  the local network for the integration; every light answers with its serial
  number. IP addresses can be typed for the lights on another network.
- **One Gladys light per LIFX light**, with only what the model can do (read
  in the official LIFX product registry, per model and firmware):
  - on/off and brightness for every light;
  - color for color lights (hue and saturation; the brightness stays its own
    feature);
  - white in kelvins, within the range of the model and firmware (1500-9000 K,
    1000-10000 K on recent firmware, none for a fixed white);
  - infrared level for the Nightvision bulbs;
  - the built-in effects of strips (Move) and matrices (Morph, Flame), as a
    list;
  - the connection of the light (answers or not), with its history.
- **Follows the changes made elsewhere** (LIFX app, voice assistant, wall
  switch) within the refresh interval, 15 seconds by default.
- **Soft transitions**: an optional fade (up to 5 s) for the changes made from
  Gladys. A light that is off takes its new color first, then fades on.
- **Scene action** _Pulse a LIFX light_: blink or breathe in a color, a number
  of times, then back to what the light showed — off included. For alerts.
- **Scene action** _Start a LIFX effect_: Move, Morph or Flame with speed,
  direction and colors, or stop the effect.
- English, French, German and Spanish, in the interface, the feature names and
  the [documentation](docs/en.md) ([fr](docs/fr.md), [de](docs/de.md),
  [es](docs/es.md)).

### Why no widget

The Gladys light box already shows and drives everything a LIFX light does
(on/off, brightness, color, white, infrared, effect list). The pulse and the
effects with their settings belong in scenes. A widget would only repeat the
light box, so there is none.

## Requirements

- Gladys Assistant **5.1.0** or later (scene actions, mediated discovery).
- LIFX lights set up in the LIFX app, on the network of Gladys.

## Installation

In Gladys, open **Integrations**, then **Install from GitHub**, and enter the
address of this repository:

```
https://github.com/guim31/gladys-lifx
```

Then open the **Discover** tab of the integration and add the lights. The
[documentation](docs/en.md) details the options and the scene actions.

## How it works

- The LIFX LAN protocol is binary, over UDP port 56700: a 36-byte header
  (size, protocol 1024, source, target serial, flags, sequence, message type)
  then the payload of the message, every number little-endian. The integration
  implements the messages it needs (`src/lifx/packet.js`), each one tested
  against the byte layout of the protocol description, including the
  `SetColor` example of the LIFX documentation byte for byte.
- The integration runs in an isolated container on a Docker bridge: a
  broadcast it sent would never reach the LAN. The **discovery broadcast** is
  sent by the Gladys core (`udp-active-broadcast` mediated discovery, port
  56700 declared in the manifest): the integration forges the `GetService`
  packet and reads the `StateService` replies the core relays. The lights are
  then reached in unicast.
- **Polling, not push**: a LIFX light never pushes its changes. The integration
  reads every light added to Gladys with its own timer (`LightGet`, plus the
  infrared level and the running effect when the product has them), and
  publishes only what changed, with a heartbeat every 6 hours. Gladys never
  polls these devices (`should_poll: false`): its scheduler cannot be trusted
  with external devices (GladysAssistant/Gladys#3198). `onPoll` stays as a
  fallback.
- Commands are acknowledged `Set` messages, sent again until acknowledged. A
  color, a white or a brightness is written with `SetWaveformOptional`, which
  only changes the given components (a color changed in the LIFX app is not
  overwritten), like Home Assistant does; a firmware without it gets
  `SetColor`. Reads wait for the end of a transition.
- Each light is identified by its serial number: a light that changes IP
  address (DHCP) keeps its Gladys device. The lights seen are kept in
  `/data/lifx-state.json` (address, product, firmware, label: nothing secret).
- LIFX asks clients to stay under 20 messages per second per light: the
  integration sends one message at a time per light, a few per reading.

## Checked, and what was not

Checked:

- every kind of light of the fixtures (an A19 on firmware 2.80, an Original on
  firmware 1.5 without `SetWaveformOptional`, a Mini White, a Mini Day & Dusk,
  a Nightvision, a Z strip, a Beam on legacy zone messages, a Neon, a Tile, a
  Candle, a Filament, a Clean, a Switch and a product newer than the registry)
  against the rules of the Gladys core (feature couples, bounds, units, poll
  frequencies) in the four languages;
- the packets against an independent decoder written from the protocol
  description, over real UDP sockets;
- the whole integration against the fake Gladys of the SDK.

Not checked, for want of hardware or of a Gladys instance:

- a real LIFX light: how each firmware renders the waveforms, the Move
  direction, the effect speeds, the colour a strip or a matrix reports for the
  whole device;
- the discovery broadcast through a real Gladys core on a real LAN;
- the rendering of the scene cards in the Gladys interface.

## Limitations

- Changes made outside Gladys are seen at the next reading (10 to 60 s).
- Strips and matrices are driven as a whole: no color per zone.
- Not handled: the LIFX Switch, the HEV cleaning cycle of the LIFX Clean (the
  bulb works as a color light; switching UV light from a scene is left out on
  purpose), the Sky and Color sweep effects, the LIFX cloud.
- A product newer than the product registry of this version is handled as a
  color light with a 1500-9000 K range until an update.

## Development

```bash
npm install
npm test                 # node --test, against fake lights on real UDP and the SDK's fake Gladys
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store admission checks
```

- `node tools/fake-lifx.mjs [fixture]` runs a fake LIFX light on UDP port
  56700 of the machine, from one of the fixtures of `test/fixtures/lifx`: run
  it on another machine of the network than Gladys to try the discovery and
  the commands without a LIFX light.
- `node tools/update-products.mjs <products.json>` regenerates
  `src/lifx/products-data.js` from a clone of
  [LIFX/products](https://github.com/LIFX/products), for the new models.

See [CLAUDE.md](CLAUDE.md) for the project rules and the pitfalls of the Gladys
core, and [CHANGELOG.md](CHANGELOG.md) for the changes.

## Credits

- [LIFX LAN protocol](https://lan.developer.lifx.com) and its machine-readable
  description [LIFX/public-protocol](https://github.com/LIFX/public-protocol);
  the product registry [LIFX/products](https://github.com/LIFX/products),
  under the LIFX Developer Terms, from which `src/lifx/products-data.js` is
  derived (product names and capabilities).
- [aiolifx](https://github.com/aiolifx/aiolifx) (MIT, François Wautier, Avi
  Miller and contributors): its message definitions were read to cross-check
  the payload layouts. No code was copied.
- The [Home Assistant LIFX integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/lifx)
  (Apache 2.0): the way to write a color (`SetWaveformOptional`, half sine,
  once), the fade-on order and the effect settings follow its choices.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and the [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js).

## License

[Apache-2.0](LICENSE)
