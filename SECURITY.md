# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **No secret.** The LIFX LAN protocol has no account, key nor password: the
  configuration holds IP addresses, a refresh interval, a fade and a language.
- **Stored in `/data`** (`lifx-state.json`): the LIFX lights seen, with their
  IP address, port, serial number, product, firmware and label. Nothing else is
  written, and nothing leaves the local network.
- **Network**: UDP port 56700 towards the LIFX lights of the local network, in
  unicast; the discovery broadcast is sent by the Gladys core on that port
  only (declared in the manifest). The integration listens on no port of its
  own and talks to no Internet service.
- The LIFX LAN protocol itself is not authenticated: any device of the local
  network can drive the lights the same way. That is a property of the LIFX
  lights, not of this integration.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the LIFX lights, their firmware, the LIFX app and the LIFX cloud.
