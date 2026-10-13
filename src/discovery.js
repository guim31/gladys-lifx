// -----------------------------------------------------------------------------
// Where to look for LIFX lights: the replies to a discovery broadcast the
// Gladys core emits for the integration, the addresses typed in the
// configuration, and the addresses already known.
//
// The integration container sits on a bridge network: a broadcast it sent
// would never reach the LAN, and the LIFX lights answer in unicast to whoever
// broadcast. So the core broadcasts (mediated `udp-active-broadcast`
// discovery, port declared in the manifest `network_discovery`): the
// integration forges the GetService packet, the core relays the raw
// StateService replies. The serial in the header of each reply identifies
// the light whatever address it answers on.
// -----------------------------------------------------------------------------

import {
  LIFX_PORT,
  MESSAGES,
  SERVICE_UDP,
  decode,
  decodePacket,
  encodePacket,
  normalizeSerial,
} from './lifx/packet.js';

export const SCAN_TIMEOUT_SECONDS = 5;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The broadcast request of a discovery scan (`scanNetwork` options): a tagged
 * GetService, 36 bytes, sent by the core on port 56700.
 * @param {number} source the transport's client identifier
 */
export function scanRequest(source) {
  return {
    port: LIFX_PORT,
    payload: encodePacket({ type: MESSAGES.GET_SERVICE, source, resRequired: true }),
    timeoutSeconds: SCAN_TIMEOUT_SECONDS,
  };
}

/**
 * Lights that answered a discovery scan: `[{ host, port, serial }]`, one per
 * serial. A light answers once per service: only the UDP one is kept.
 * @param {Array} replies raw results `[{ source_ip, source_port, payload_base64 }]`
 */
export function parseScanReplies(replies) {
  const found = new Map();
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (!reply || typeof reply.source_ip !== 'string' || !IPV4.test(reply.source_ip)) {
      continue;
    }
    const packet = decodePacket(Buffer.from(String(reply.payload_base64 ?? ''), 'base64'));
    if (!packet || packet.type !== MESSAGES.STATE_SERVICE) {
      continue;
    }
    let service;
    try {
      service = decode[MESSAGES.STATE_SERVICE](packet.payload);
    } catch {
      continue;
    }
    const serial = normalizeSerial(packet.target);
    if (service.service !== SERVICE_UDP || !serial || found.has(serial)) {
      continue;
    }
    const port = service.port > 0 && service.port <= 0xffff ? service.port : LIFX_PORT;
    found.set(serial, { host: reply.source_ip, port, serial });
  }
  return [...found.values()];
}

/**
 * Run `task` on every item, `limit` at a time; resolves with the results in
 * order (`{ value }` or `{ error }`).
 */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { value: await task(items[index]) };
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
