# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- LIFX lights in Gladys, on the local network, with the official LIFX LAN
  protocol: no account, no cloud.
- Automatic discovery through Gladys (Gladys 5.1 or later), and IP addresses
  to type for the lights on another network.
- One Gladys light per LIFX bulb, strip or matrix, named as in the LIFX app:
  on/off, brightness, color, white in kelvins within the range of the model and
  firmware, infrared for the Nightvision bulbs, and the connection of the
  light.
- The built-in effects of the strips (Move) and of the matrices (Morph, Flame)
  as a list on the device.
- Scene action "Pulse a LIFX light": blink or breathe in a color, then back to
  what the light showed, off included.
- Scene action "Start a LIFX effect": Move, Morph or Flame with speed,
  direction and colors, or stop the effect.
- An optional fade for the changes made from Gladys, and a refresh interval of
  10 to 60 seconds to follow the changes made in the LIFX app.
- English, French, German and Spanish everywhere, documentation included.

[Unreleased]: https://github.com/guim31/gladys-lifx/commits/main
