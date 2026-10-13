# Fake LIFX lights

One file per light simulated by `test/helpers/fakeLifx.js`, which answers the
LIFX LAN packets on a real UDP socket bound to `127.0.0.1`.

- `product` and `firmware` are the values a real light gives in StateVersion and
  StateHostFirmware; the product ids, names and capabilities are the ones of the
  official LIFX product registry (https://github.com/LIFX/products): an A19 on
  firmware 2.80, a Mini White, a Mini Day & Dusk, a Nightvision, a Z strip, a
  Beam on an old firmware (legacy zone messages only), a Neon, a Tile, a Candle,
  a Filament, a Clean, a Switch (not a light) and a product newer than the
  registry.
- `color` is the HSBK of LightState (0-65535, kelvins), `power` 0 or 65535.
- `unhandled` lists the message types the light answers with StateUnhandled,
  like an older firmware.

The serial numbers are invented (LIFX vendor prefix `d073d5`), and so are the
labels. No real device or network is described here.
