// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two reads of every LIFX light (`poll_interval` options).
export const POLL_INTERVALS = [10, 15, 30, 60];

// Milliseconds of fade for the commands from Gladys (`transition` options).
export const TRANSITIONS = [0, 250, 500, 1000, 2000, 5000];

export const DEFAULT_CONFIG = {
  hosts: '',
  poll_interval: '15',
  transition: '0',
  language: 'fr',
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAX_HOSTS = 64;

/**
 * Parse the manual address list (commas, semicolons, spaces or new lines).
 * IPv4 addresses only: the LIFX lights answer on a fixed UDP port.
 * @param {unknown} raw
 * @returns {{ hosts: string[], invalid: string[] }}
 */
export function parseHosts(raw) {
  const hosts = [];
  const invalid = [];
  const entries = typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
  for (const entry of entries) {
    const host = entry.trim();
    if (!host) {
      continue;
    }
    const match = host.match(IPV4);
    if (!match || !match.slice(1).every((part) => Number(part) <= 255)) {
      invalid.push(host);
    } else {
      // Leading zeros would make another string for the same address.
      const normalized = match.slice(1).map(Number).join('.');
      if (!hosts.includes(normalized) && hosts.length < MAX_HOSTS) {
        hosts.push(normalized);
      }
    }
  }
  return { hosts, invalid };
}

const pickNumber = (raw, allowed, fallback) => {
  const value = Number(raw ?? fallback);
  return allowed.includes(value) ? value : Number(fallback);
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const { hosts, invalid } = parseHosts(
    typeof source.hosts === 'string' ? source.hosts : DEFAULT_CONFIG.hosts,
  );
  return {
    hosts,
    invalidHosts: invalid,
    pollSeconds: pickNumber(source.poll_interval, POLL_INTERVALS, DEFAULT_CONFIG.poll_interval),
    transitionMs: pickNumber(source.transition, TRANSITIONS, DEFAULT_CONFIG.transition),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
