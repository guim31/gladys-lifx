// -----------------------------------------------------------------------------
// The LIFX hub: finds the lights, reads them at the configured pace, publishes
// their devices and states to Gladys, and runs the commands, the pulse and the
// firmware effects.
//
// Polling only: a LIFX light never pushes its changes. The hub reads every
// light the user added to Gladys itself (LightGet, plus the infrared level and
// the running effect when the product has them), every 15 s by default.
// Gladys never polls these devices (should_poll: false): its scheduler cannot
// be trusted with external devices (GladysAssistant/Gladys#3198). The
// `onPoll` of src/app.js stays as a fallback and skips a light read less than
// half a period ago.
// -----------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import { GladysApiError, createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE_KEYS,
  buildDevice,
  deviceIds,
  deviceName,
  deviceValues,
  featureSpecs,
} from './devices.js';
import { mapLimit, parseScanReplies, scanRequest } from './discovery.js';
import { ProblemLog } from './problems.js';
import { CONNECTION_TEXT } from './texts.js';
import { U16, clamp, fromPercent, rgbIntToHueSaturation } from './lifx/color.js';
import {
  DEFAULT_DIRECTION,
  DEFAULT_PALETTE,
  DEFAULT_PULSE_COLOR,
  DEFAULT_PULSE_MODE,
  DEFAULT_PULSE_PERIOD,
  DEFAULT_SPEED,
  DIRECTIONS,
  EFFECTS,
  KEEP_COLORS,
  NO_EFFECT,
  OTHER_EFFECT,
  PALETTES,
  PULSE_COLORS,
  PULSE_CYCLES,
  PULSE_MODES,
  PULSE_PERIODS,
  SPEEDS,
  effectKey,
  effectsOf,
  paletteColors,
} from './lifx/effects.js';
import {
  APPLY,
  EXTENDED_ZONES_PER_MESSAGE,
  LIFX_PORT,
  MESSAGES,
  MULTI_ZONE_EFFECTS,
  SERVICE_UDP,
  TILE_EFFECTS,
  WAVEFORMS,
  decode,
  encode,
  normalizeSerial,
} from './lifx/packet.js';
import { capabilitiesOf } from './lifx/products.js';

const logger = createLogger({ name: 'lifx-hub' });

export const HUB_TIMINGS = {
  // New scan, to follow DHCP changes and find new lights (Home Assistant
  // does the same every 15 minutes).
  rediscoveryMs: 15 * 60_000,
  // Reads in a row without answer before a light is "unreachable".
  unreachableAfter: 2,
  // After a command, the reads wait for the end of its transition, and this
  // much more, so a light still fading is not shown at a middle value.
  settleMs: 1_500,
  // An unchanged value is still sent this often, so Gladys never shows it
  // as stale ("no recent value" after 48 h).
  heartbeatMs: 6 * 3_600_000,
};

const PROBE_CONCURRENCY = 8;
const POLL_CONCURRENCY = 8;

/**
 * Gladys refused a call or did not answer (restart, network, rate limit): a
 * passing condition, unlike a bug in the integration.
 */
const isGladysFailure = (err) =>
  err instanceof GladysApiError ||
  err?.name === 'TimeoutError' ||
  err?.name === 'AbortError' ||
  (err instanceof TypeError && err.message === 'fetch failed');

/** "fetch failed (ECONNREFUSED)": the low-level code Node hides in `cause`. */
const describe = (err) => {
  const code = err?.cause?.code;
  return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
};

const isGiven = (value) => value !== undefined && value !== null && String(value).trim() !== '';

export class LifxHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {object} options.store persistence (src/store.js)
   * @param {object} options.transport LifxTransport
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now] clock (tests)
   */
  constructor({ gladys, store, transport, timers = true, timings, now = () => Date.now() }) {
    this.gladys = gladys;
    this.store = store;
    this.transport = transport;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now;
    // Where the typed addresses are asked (a test seam: the LIFX port).
    this.defaultPort = LIFX_PORT;
    this.config = null;
    /** @type {Map<string, object>} light records, by serial */
    this.records = new Map();
    this.pending = new Set();
    /** @type {Set<NodeJS.Timeout>} pulses waiting to put a light back off */
    this.restoreTimers = new Set();
    this.pollTimer = null;
    this.rediscoveryTimer = null;
    this.polling = null;
    this.discovering = null;
    this.lastScan = { status: 'not-run', found: 0 };
    this.stopped = false;
    // Repeated failures (Gladys refusing, a light answering garbage): one
    // line when they start and one when they end.
    this.problems = new ProblemLog(logger);
    // Products that are not lights (the LIFX Switch), said once each.
    this.ignored = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    await this.restore();
    await this.discover();
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.startTimers();
  }

  /** Gladys came back (restart, network): it may have lost what was published. */
  async resync(config) {
    this.config = config;
    this.gladys.forgetPublishedStates();
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.gladysRecovered();
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    if (!previous || previous.hosts.join(',') !== config.hosts.join(',')) {
      await this.discover();
    }
    if (previous && previous.pollSeconds !== config.pollSeconds) {
      this.startTimers();
    }
    // New lights, or feature names in another language for the Discovery list.
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
  }

  startTimers() {
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    clearInterval(this.pollTimer);
    clearInterval(this.rediscoveryTimer);
    this.pollTimer = setInterval(() => this.track(this.pollAll()), this.config.pollSeconds * 1000);
    this.rediscoveryTimer = setInterval(
      () => this.track(this.rediscover()),
      this.timings.rediscoveryMs,
    );
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.rediscoveryTimer);
    for (const timer of this.restoreTimers) {
      clearTimeout(timer);
    }
    this.restoreTimers.clear();
    await this.idle();
    this.transport.close();
    await this.store.flush();
  }

  /** Keep track of background work, so the tests (and stop) can wait for it. */
  track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((err) => this.backgroundFailed(err))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  /**
   * A periodic task failed. Gladys refusing or away is said once until it
   * accepts again; a bug is logged with its stack, once per message.
   */
  backgroundFailed(err) {
    if (isGladysFailure(err)) {
      this.problems.fail('gladys', `Gladys does not take the LIFX updates: ${describe(err)}`);
    } else {
      this.problems.fail(`bug:${err?.message}`, 'Background task failed', 'error', err);
    }
  }

  gladysRecovered() {
    this.problems.recover('gladys', 'Gladys takes the LIFX updates again');
  }

  /** Resolves once no background work is left. */
  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // --- Persistence -----------------------------------------------------------

  async restore() {
    const data = await this.store.load();
    for (const [key, saved] of Object.entries(data.lights ?? {})) {
      const serial = normalizeSerial(key);
      if (!serial || !saved || typeof saved.host !== 'string' || !saved.version) {
        continue;
      }
      const record = this.createRecord(serial, saved.host, saved.port);
      record.version = saved.version;
      record.firmware = saved.firmware ?? { major: 0, minor: 0 };
      record.label = typeof saved.label === 'string' ? saved.label : '';
      record.caps = capabilitiesOf(record.version, record.firmware);
      if (record.caps) {
        this.records.set(serial, record);
      }
    }
  }

  save() {
    const lights = {};
    for (const record of this.records.values()) {
      lights[record.serial] = {
        host: record.host,
        port: record.port,
        version: record.version,
        firmware: record.firmware,
        label: record.label,
      };
    }
    return this.store.save({ lights });
  }

  // --- Discovery -------------------------------------------------------------

  createRecord(serial, host, port = LIFX_PORT) {
    return {
      serial,
      host,
      port: Number.isInteger(port) && port > 0 ? port : LIFX_PORT,
      version: null,
      firmware: null,
      label: '',
      caps: null,
      // Last LightGet: { hue, saturation, brightness, kelvin, power }.
      light: null,
      infrared: null,
      // Running effect key, null while unknown.
      effect: null,
      // Messages its firmware answered "unhandled" to: not sent again.
      unhandled: new Set(),
      // null until the first answer or the first scan without one.
      reachable: null,
      failures: 0,
      // Bumped on every command: a read started before it is stale.
      commandSeq: 0,
      settleUntil: 0,
      lastReadAt: null,
    };
  }

  /** Where to reach a light (the transport target). */
  target(record) {
    return { host: record.host, port: record.port, serial: record.serial };
  }

  /**
   * Scan through the Gladys core, then probe the typed, found and known
   * addresses. Resolves with the number of lights answering.
   */
  discover() {
    this.discovering ??= this.runDiscovery().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  async runDiscovery() {
    // Priority when one light answers on several addresses: the one the scan
    // found, then the one known from before, then the typed one.
    const targets = [];
    const add = (target) => {
      if (!targets.some((known) => known.host === target.host && known.port === target.port)) {
        targets.push(target);
      }
    };
    (await this.scan()).forEach(add);
    [...this.records.values()].forEach((record) => add(this.target(record)));
    this.config.hosts.forEach((host) => add({ host, port: this.defaultPort, serial: null }));

    const results = await mapLimit(targets, PROBE_CONCURRENCY, (target) => this.probe(target));
    const answers = new Map();
    results.forEach((result, index) => {
      const target = targets[index];
      if (result.error) {
        logger.debug(`No LIFX answer from ${target.host}: ${result.error.message}`);
      } else if (result.value && !answers.has(result.value.serial)) {
        answers.set(result.value.serial, result.value);
      }
    });
    for (const answer of answers.values()) {
      const record = this.adopt(answer);
      await this.applyReading(record, answer.reading);
    }
    for (const record of this.records.values()) {
      if (!answers.has(record.serial) && record.reachable === null) {
        // Known from /data, silent since the start: unreachable, no event.
        record.reachable = false;
      }
    }
    await this.save();
    logger.debug(
      `Discovery: ${answers.size} LIFX light(s) answering of ${targets.length} address(es)`,
    );
    return answers.size;
  }

  /** One discovery broadcast through the Gladys core: `[{ host, port, serial }]`. */
  async scan() {
    try {
      const found = parseScanReplies(
        await this.gladys.scanNetwork('udp-active-broadcast', scanRequest(this.transport.source)),
      );
      this.lastScan = { status: 'ok', found: found.length };
      this.problems.recover('scan', 'LIFX discovery through Gladys works again');
      return found;
    } catch (err) {
      // 403: a core without mediated discovery; 429 or 409: a scan ran less
      // than 10 s ago. The typed and known addresses still work.
      // Said once, not at every rediscovery; "busy" passes by itself.
      const status = err.status === 429 || err.status === 409 ? 'busy' : 'unavailable';
      const message = `LIFX discovery through Gladys failed: ${describe(err)}`;
      if (status === 'busy') {
        logger.debug(message);
      } else {
        this.problems.fail('scan', message);
      }
      this.lastScan = { status, found: 0 };
      return [];
    }
  }

  /**
   * Ask one address what it is: `{ serial, host, port, version, firmware,
   * caps, reading }`, or null for a LIFX device that is not a light. The
   * product of a light already known (same firmware) is not asked again.
   */
  async probe(target) {
    let { serial, port } = target;
    if (!serial) {
      // A typed address: GetService tells the serial (and the port).
      const reply = await this.transport.request(target, MESSAGES.GET_SERVICE, {
        expect: [MESSAGES.STATE_SERVICE],
        accept: (packet) => isUdpService(packet.payload),
      });
      serial = normalizeSerial(reply.target);
      port = reply.data.port || LIFX_PORT;
      if (!serial) {
        throw new Error(`${target.host} answered without a serial`);
      }
    }
    const device = { host: target.host, port, serial };
    const firmware = (
      await this.transport.request(device, MESSAGES.GET_HOST_FIRMWARE, {
        expect: [MESSAGES.STATE_HOST_FIRMWARE],
      })
    ).data;
    const known = this.records.get(serial);
    const sameFirmware =
      known?.version &&
      known.firmware?.major === firmware.major &&
      known.firmware?.minor === firmware.minor;
    const version = sameFirmware
      ? known.version
      : (
          await this.transport.request(device, MESSAGES.GET_VERSION, {
            expect: [MESSAGES.STATE_VERSION],
          })
        ).data;
    const caps = capabilitiesOf(version, firmware);
    if (!caps) {
      if (!this.ignored.has(serial)) {
        this.ignored.add(serial);
        logger.info(
          `LIFX device ${serial} at ${target.host} is not a light (product ${version.product}): ignored`,
        );
      }
      return null;
    }
    if (!caps.known && !this.ignored.has(`unknown:${serial}`)) {
      this.ignored.add(`unknown:${serial}`);
      logger.info(
        `LIFX product ${version.product} is not in the product list of this version: ${serial} handled as a colour light`,
      );
    }
    const record = known ?? { ...this.createRecord(serial, target.host, port), caps };
    const reading = await this.read({ ...record, ...device, caps });
    return { serial, host: target.host, port, version, firmware, caps, reading };
  }

  /** Take a probe answer: a new light is added, a known one may have moved. */
  adopt(answer) {
    let record = this.records.get(answer.serial);
    if (!record) {
      record = this.createRecord(answer.serial, answer.host, answer.port);
      this.records.set(answer.serial, record);
      logger.info(
        `${answer.caps.product ?? 'LIFX light'} ${answer.serial} found at ${answer.host}`,
      );
    } else if (record.host !== answer.host || record.port !== answer.port) {
      logger.info(`LIFX light ${answer.serial} moved from ${record.host} to ${answer.host}`);
    }
    Object.assign(record, {
      host: answer.host,
      port: answer.port,
      version: answer.version,
      firmware: answer.firmware,
      caps: answer.caps,
    });
    return record;
  }

  async rediscover() {
    await this.discover();
    // New lights, and new addresses (DHCP) for the params of the created
    // devices.
    await this.publishDevices();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.gladysRecovered();
  }

  // --- Devices ---------------------------------------------------------------

  async publishDevices() {
    const devices = [...this.records.values()].map((record) =>
      buildDevice(this.gladys, record, this.config.language),
    );
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** The record behind a Gladys device external id, or null. */
  resolveDevice(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    const prefix = deviceIds(this.gladys, '').device;
    if (!externalId.startsWith(prefix)) {
      return null;
    }
    return this.records.get(externalId.slice(prefix.length)) ?? null;
  }

  isCreated(record) {
    const id = deviceIds(this.gladys, record.serial).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === id);
  }

  require(externalId) {
    const record = this.resolveDevice(externalId);
    if (!record) {
      throw new Error(`Unknown LIFX light ${externalId}`);
    }
    return record;
  }

  label(record) {
    return `LIFX "${deviceName(record)}"`;
  }

  // --- States ----------------------------------------------------------------

  /**
   * Publish what changed for one light, if the user created it (Gladys caps
   * states at 300 a minute and re-evaluates scenes on each one).
   */
  async publishStates(record) {
    if (!record.caps || !this.isCreated(record)) {
      return;
    }
    const ids = deviceIds(this.gladys, record.serial);
    const values = deviceValues(record);
    const states = [];
    for (const spec of featureSpecs(record.caps, this.config.language)) {
      const value = values[spec.key];
      if (value === undefined) {
        continue;
      }
      states.push(
        typeof value === 'object'
          ? { device_feature_external_id: ids.feature(spec.key), text: value.text }
          : { device_feature_external_id: ids.feature(spec.key), state: value },
      );
    }
    // The SDK sends only the values that changed since its last publication,
    // and an unchanged one again once the heartbeat is due.
    const result = await this.gladys.publishChangedStates(states, {
      heartbeat: this.timings.heartbeatMs,
    });
    if (result?.count > 0) {
      logger.debug(`${record.serial}: ${result.count} state(s) sent to Gladys`);
    }
  }

  async publishAllStates() {
    for (const record of this.records.values()) {
      try {
        await this.publishStates(record);
      } catch (err) {
        logger.debug(`Cannot publish the states of ${record.serial}: ${err.message}`);
        this.backgroundFailed(err);
      }
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Read the light now and send them again.
   */
  async onDeviceCreated(device) {
    const record = this.resolveDevice(device?.external_id);
    if (!record) {
      return;
    }
    this.gladys.forgetPublishedStates(device.external_id);
    await this.refresh(record, { force: true });
    await this.publishStates(record);
    await this.publishTransports([record]);
  }

  async publishTransports(records = [...this.records.values()]) {
    const entries = records
      .filter((record) => this.isCreated(record))
      .map((record) => ({
        external_id: deviceIds(this.gladys, record.serial).device,
        transport: record.reachable === true ? 'local' : 'unreachable',
      }));
    for (let at = 0; at < entries.length; at += 100) {
      await this.gladys.publishTransports(entries.slice(at, at + 100));
    }
  }

  async publishConnectionStatus() {
    const records = [...this.records.values()];
    if (records.length === 0) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noDevice);
    } else if (!records.some((record) => record.reachable === true)) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noAnswer);
    } else {
      await this.gladys.setConnectionStatus(true);
    }
  }

  // --- Reading -----------------------------------------------------------------

  /**
   * Read every light the user added once (the timer's job). The lights not
   * added are not read: Gladys would drop their states.
   */
  pollAll() {
    this.polling ??= mapLimit(
      [...this.records.values()].filter((record) => this.isCreated(record)),
      POLL_CONCURRENCY,
      (record) => this.refresh(record, { minGap: 0.5 }),
    )
      .then((results) => {
        // A light that does not answer is handled by refresh; what is left
        // is Gladys refusing the states (or a bug).
        const errors = results.filter((result) => result.error).map((result) => result.error);
        errors.forEach((err) => this.backgroundFailed(err));
        if (errors.length === 0) {
          this.gladysRecovered();
        }
      })
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  /**
   * Read one light and publish what changed. Skipped while a command settles,
   * or when the light was read less than `minGap` periods ago (`force`
   * reads anyway).
   */
  async refresh(record, { force = false, minGap = 0 } = {}) {
    const now = this.now();
    if (!force) {
      if (now < record.settleUntil) {
        logger.debug(`${record.serial}: a command is settling, read skipped`);
        return;
      }
      const gap = this.config.pollSeconds * 1000 * minGap;
      if (record.lastReadAt !== null && now - record.lastReadAt < gap) {
        logger.debug(`${record.serial}: read ${now - record.lastReadAt} ms ago, skipped`);
        return;
      }
    }
    record.lastReadAt = now;
    const seq = record.commandSeq;
    let reading;
    try {
      reading = await this.read(record);
    } catch (err) {
      if (err.unreachable) {
        await this.failed(record);
      } else {
        this.problems.fail(`read:${record.serial}`, `Cannot read ${record.host}: ${err.message}`);
      }
      return;
    }
    this.problems.recover(`read:${record.serial}`, `${this.label(record)} reads again`);
    if (seq !== record.commandSeq) {
      // A Gladys command ran meanwhile: this reading may predate it.
      return;
    }
    await this.applyReading(record, reading);
  }

  /**
   * One reading of a light: its LightState, and its infrared level and
   * running effect when the product has them. A message the firmware does
   * not handle is left out from then on.
   */
  async read(record) {
    const target = this.target(record);
    const light = (
      await this.transport.request(target, MESSAGES.LIGHT_GET, {
        expect: [MESSAGES.LIGHT_STATE],
      })
    ).data;
    const reading = { light };
    const optional = async (type, expect, payload) => {
      if (record.unhandled?.has(type)) {
        return null;
      }
      try {
        return (await this.transport.request(target, type, { expect: [expect], payload })).data;
      } catch (err) {
        if (err.kind === 'unhandled') {
          record.unhandled?.add(type);
          return null;
        }
        throw err;
      }
    };
    const { caps } = record;
    if (caps.infrared) {
      const infrared = await optional(MESSAGES.LIGHT_GET_INFRARED, MESSAGES.LIGHT_STATE_INFRARED);
      reading.infrared = infrared?.brightness ?? null;
    }
    if (caps.multizone) {
      const effect = await optional(
        MESSAGES.GET_MULTI_ZONE_EFFECT,
        MESSAGES.STATE_MULTI_ZONE_EFFECT,
      );
      reading.effect = effect ? effectKey('multizone', effect.type) : null;
    } else if (caps.matrix) {
      const effect = await optional(
        MESSAGES.GET_TILE_EFFECT,
        MESSAGES.STATE_TILE_EFFECT,
        encode.getTileEffect(),
      );
      reading.effect = effect ? effectKey('matrix', effect.type) : null;
    }
    return reading;
  }

  /** A fresh reading: publish what changed, follow the reachability. */
  async applyReading(record, reading) {
    const { label, ...light } = reading.light;
    logger.debug(
      `${record.serial} read: power ${light.power}, hue ${light.hue}, saturation ${light.saturation}, ` +
        `brightness ${light.brightness}, ${light.kelvin} K` +
        (reading.infrared != null ? `, infrared ${reading.infrared}` : '') +
        (reading.effect != null ? `, effect ${reading.effect}` : ''),
    );
    record.light = light;
    if (typeof label === 'string' && label !== record.label) {
      record.label = label;
      this.track(this.save());
    }
    if (reading.infrared !== undefined && reading.infrared !== null) {
      record.infrared = reading.infrared;
    }
    if (reading.effect !== undefined && reading.effect !== null) {
      record.effect = reading.effect;
    }
    record.failures = 0;
    if (record.reachable !== true) {
      const cameBack = record.reachable === false;
      record.reachable = true;
      if (cameBack) {
        logger.info(`${this.label(record)} answers again at ${record.host}`);
      }
      await this.publishTransports([record]);
      await this.publishConnectionStatus();
    }
    await this.publishStates(record);
  }

  /**
   * A read without answer. After a few in a row the light is unreachable:
   * most often switched off at the wall, so it is shown off.
   */
  async failed(record) {
    if (this.stopped) {
      return;
    }
    record.failures += 1;
    if (record.failures < this.timings.unreachableAfter || record.reachable === false) {
      return;
    }
    record.reachable = false;
    logger.info(`${this.label(record)} no longer answers at ${record.host}`);
    await this.publishStates(record);
    await this.publishTransports([record]);
    await this.publishConnectionStatus();
  }

  // --- Commands ----------------------------------------------------------------

  /** One acknowledged Set; a light that does not answer fails the command. */
  async send(record, type, payload) {
    try {
      await this.transport.command(this.target(record), type, payload);
    } catch (err) {
      if (err.unreachable) {
        await this.failed(record);
        throw new Error(`${this.label(record)} does not answer at ${record.host}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  /** Mark a command: the reads in flight are stale, the next wait for it to settle. */
  commandStarted(record, durationMs) {
    record.commandSeq += 1;
    record.settleUntil = this.now() + durationMs + this.timings.settleMs;
  }

  /** The command went through: the light answered, show its new state now. */
  async commandDone(record) {
    if (record.reachable !== true) {
      record.reachable = true;
      record.failures = 0;
      await this.publishTransports([record]);
      await this.publishConnectionStatus();
    }
    await this.publishStates(record);
  }

  /** The last reading, or a fresh one when the light was never read. */
  async ensureReading(record) {
    if (!record.light) {
      await this.readNow(record);
    }
    return record.light;
  }

  /** Turn a light on or off, with the configured fade. */
  async setPower(record, on) {
    const duration = this.config.transitionMs;
    this.commandStarted(record, duration);
    await this.send(record, MESSAGES.LIGHT_SET_POWER, encode.setLightPower({ on, duration }));
    record.light = { ...(record.light ?? {}), power: on ? U16 : 0 };
    await this.commandDone(record);
  }

  /**
   * Change some components of the colour (`changes`: hue, saturation,
   * brightness, kelvin), and turn the light on. A light that is off takes
   * the colour at once, then fades on: it never flashes its previous colour.
   */
  async setLight(record, changes) {
    const duration = this.config.transitionMs;
    const current = await this.ensureReading(record);
    const fadingOn = !(current.power > 0);
    this.commandStarted(record, duration);
    await this.writeColor(record, changes, fadingOn ? 0 : duration);
    if (fadingOn) {
      await this.send(
        record,
        MESSAGES.LIGHT_SET_POWER,
        encode.setLightPower({ on: true, duration }),
      );
    }
    record.light = { ...record.light, ...changes, power: U16 };
    await this.commandDone(record);
  }

  /**
   * SetWaveformOptional writes only the components given, so a colour
   * changed in the LIFX app since the last read is not overwritten. A
   * firmware without it gets a SetColor of the whole colour.
   */
  async writeColor(record, changes, period) {
    const color = { ...record.light, ...changes };
    if (!record.unhandled.has(MESSAGES.LIGHT_SET_WAVEFORM_OPTIONAL)) {
      try {
        await this.send(
          record,
          MESSAGES.LIGHT_SET_WAVEFORM_OPTIONAL,
          encode.setWaveformOptional({
            color,
            period,
            cycles: 1,
            waveform: WAVEFORMS.HALF_SINE,
            transient: false,
            set: {
              hue: 'hue' in changes,
              saturation: 'saturation' in changes,
              brightness: 'brightness' in changes,
              kelvin: 'kelvin' in changes,
            },
          }),
        );
        return;
      } catch (err) {
        if (err.kind !== 'unhandled') {
          throw err;
        }
        record.unhandled.add(MESSAGES.LIGHT_SET_WAVEFORM_OPTIONAL);
      }
    }
    await this.send(record, MESSAGES.LIGHT_SET_COLOR, encode.setColor({ color, duration: period }));
  }

  /** A Gladys command on a feature of one of the lights. */
  async setValue(device, feature, value) {
    const record = this.require(device?.external_id);
    const prefix = `${device.external_id}:`;
    const key = feature?.external_id?.startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : null;
    const { caps } = record;
    const number = Number(value);
    logger.debug(`${record.serial}: ${key} = ${value}`);
    switch (key) {
      case FEATURE_KEYS.POWER:
        return this.setPower(record, number > 0);

      case FEATURE_KEYS.BRIGHTNESS:
        if (!Number.isFinite(number)) {
          break;
        }
        if (number <= 0) {
          return this.setPower(record, false);
        }
        return this.setLight(record, { brightness: fromPercent(clamp(number, 1, 100)) });

      case FEATURE_KEYS.COLOR:
        if (!caps.color || !Number.isFinite(number)) {
          break;
        }
        await this.stopRunningEffect(record);
        return this.setLight(record, rgbIntToHueSaturation(number));

      case FEATURE_KEYS.TEMPERATURE:
        if (!caps.temperature || !Number.isFinite(number)) {
          break;
        }
        await this.stopRunningEffect(record);
        return this.setLight(record, {
          ...(caps.color ? { saturation: 0 } : {}),
          kelvin: clamp(Math.round(number), caps.kelvin.min, caps.kelvin.max),
        });

      case FEATURE_KEYS.INFRARED:
        if (!caps.infrared || !Number.isFinite(number)) {
          break;
        }
        return this.setInfrared(record, clamp(number, 0, 100));

      case FEATURE_KEYS.EFFECT:
        if (value === OTHER_EFFECT) {
          // Nothing to start: show the real state back.
          this.gladys.forgetPublishedStates(feature.external_id);
          return this.publishStates(record);
        }
        await this.runEffect(record, { effect: value === NO_EFFECT ? 'stop' : String(value) });
        return undefined;

      default:
        break;
    }
    throw new Error(`Feature "${key}" cannot be set on this LIFX light`);
  }

  async setInfrared(record, percent) {
    this.commandStarted(record, 0);
    const brightness = fromPercent(percent);
    await this.send(record, MESSAGES.LIGHT_SET_INFRARED, encode.setInfrared({ brightness }));
    record.infrared = brightness;
    await this.commandDone(record);
  }

  // --- Pulse -----------------------------------------------------------------------

  /**
   * Make a light blink or breathe in a colour, `cycles` times, then go back
   * to what it showed. A light that is off lights up for the pulse and goes
   * back off after it.
   * @returns {Promise<{ durationMs: number }>}
   */
  async pulse(deviceExternalId, { color, mode, period, cycles } = {}) {
    const record = this.require(deviceExternalId);
    const shape = PULSE_MODES[isGiven(mode) ? mode : DEFAULT_PULSE_MODE];
    if (!shape) {
      throw new Error(`Unknown pulse mode "${mode}"`);
    }
    const colorKey = isGiven(color) ? String(color) : DEFAULT_PULSE_COLOR;
    if (!(colorKey in PULSE_COLORS)) {
      throw new Error(`Unknown pulse color "${color}"`);
    }
    const periodMs = PULSE_PERIODS.includes(Number(period)) ? Number(period) : DEFAULT_PULSE_PERIOD;
    const count =
      isGiven(cycles) && Number.isFinite(Number(cycles))
        ? clamp(Math.round(Number(cycles)), PULSE_CYCLES.min, PULSE_CYCLES.max)
        : PULSE_CYCLES.default;

    // A fresh reading: the colour to come back to.
    const reading = await this.readNow(record);
    const original = { ...reading.light };
    const hueSat = record.caps.color ? PULSE_COLORS[colorKey] : null;
    const alert = {
      hue: hueSat ? Math.round(((hueSat[0] % 360) / 360) * U16) : original.hue,
      saturation: hueSat ? Math.round(hueSat[1] * U16) : 0,
      brightness: U16,
      kelvin: original.kelvin,
    };
    const durationMs = periodMs * count;
    const wasOff = !(original.power > 0);
    this.commandStarted(record, durationMs);
    logger.info(
      `${this.label(record)}: ${mode ?? DEFAULT_PULSE_MODE} ${colorKey}, ${count} × ${periodMs} ms`,
    );
    if (wasOff) {
      // Dark in the alert colour, then on: the pulse goes from dark to bright.
      await this.send(
        record,
        MESSAGES.LIGHT_SET_COLOR,
        encode.setColor({ color: { ...alert, brightness: 0 }, duration: 0 }),
      );
      await this.send(record, MESSAGES.LIGHT_SET_POWER, encode.setLightPower({ on: true }));
    }
    await this.send(
      record,
      MESSAGES.LIGHT_SET_WAVEFORM,
      encode.setWaveform({
        color: alert,
        period: periodMs,
        cycles: count,
        skew: 0,
        waveform: shape.waveform,
        transient: true,
      }),
    );
    if (wasOff) {
      this.restoreAfter(record, durationMs, original, record.commandSeq);
    }
    await this.commandDone(record);
    return { durationMs };
  }

  /** Read a light now (the scene actions want its real state). */
  async readNow(record) {
    let reading;
    try {
      reading = await this.read(record);
    } catch (err) {
      if (err.unreachable) {
        await this.failed(record);
        throw new Error(`${this.label(record)} does not answer at ${record.host}`, {
          cause: err,
        });
      }
      throw err;
    }
    await this.applyReading(record, reading);
    return reading;
  }

  /**
   * After a pulse on a light that was off: off again, with its colour back.
   * Unless a command came meanwhile: the light is then what it asked.
   */
  restoreAfter(record, delayMs, original, seq) {
    const timer = setTimeout(() => {
      this.restoreTimers.delete(timer);
      if (record.commandSeq !== seq) {
        return;
      }
      this.track(
        (async () => {
          await this.send(record, MESSAGES.LIGHT_SET_POWER, encode.setLightPower({ on: false }));
          await this.send(
            record,
            MESSAGES.LIGHT_SET_COLOR,
            encode.setColor({ color: original, duration: 0 }),
          );
          record.light = { ...original, power: 0 };
          await this.publishStates(record);
        })().catch((err) => {
          logger.warn(
            `${this.label(record)}: cannot switch it back off after the pulse: ${err.message}`,
          );
        }),
      );
    }, delayMs + 200);
    timer.unref?.();
    this.restoreTimers.add(timer);
  }

  // --- Firmware effects --------------------------------------------------------------

  /**
   * Start a firmware effect (or stop the running one) from a scene action.
   * @param {string} deviceExternalId
   * @param {object} options effect, speed, direction, palette
   */
  async startEffect(deviceExternalId, options = {}) {
    const record = this.require(deviceExternalId);
    logger.info(`${this.label(record)}: effect ${options.effect ?? '?'}`);
    return this.runEffect(record, options);
  }

  async runEffect(record, { effect, speed, direction, palette } = {}) {
    const { caps } = record;
    if (effect === 'stop') {
      await this.stopEffect(record);
      return { effect: NO_EFFECT };
    }
    const definition = EFFECTS[effect];
    if (!definition) {
      throw new Error(`Unknown LIFX effect "${effect}"`);
    }
    if (!effectsOf(caps).includes(effect)) {
      throw new Error(`${this.label(record)} cannot run the effect "${effect}"`);
    }
    const speedMs = SPEEDS[isGiven(speed) ? speed : DEFAULT_SPEED] ?? SPEEDS[DEFAULT_SPEED];
    const paletteKey = isGiven(palette) ? String(palette) : DEFAULT_PALETTE;
    if (paletteKey !== KEEP_COLORS && !(paletteKey in PALETTES)) {
      throw new Error(`Unknown palette "${palette}"`);
    }
    const current = await this.ensureReading(record);
    const transition = this.config.transitionMs;
    this.commandStarted(record, transition);
    // The effect paints with the light's brightness; a very dim light gets
    // enough to see it.
    const brightness = Math.max(current.brightness ?? U16, fromPercent(20));
    // "Colors already shown" only means something to Move: Morph needs a palette.
    const colors =
      paletteKey === KEEP_COLORS
        ? effect === 'morph'
          ? paletteColors(DEFAULT_PALETTE, brightness, current.kelvin)
          : []
        : paletteColors(paletteKey, brightness, current.kelvin);

    if (effect === 'move') {
      if (colors.length > 0) {
        await this.paintZones(record, colors);
      }
      const way = DIRECTIONS[isGiven(direction) ? direction : DEFAULT_DIRECTION];
      await this.send(
        record,
        MESSAGES.SET_MULTI_ZONE_EFFECT,
        encode.setMultiZoneEffect({
          instanceId: randomInt(1, 0x7fffffff),
          type: MULTI_ZONE_EFFECTS.MOVE,
          speed: speedMs,
          direction: way ?? DIRECTIONS[DEFAULT_DIRECTION],
        }),
      );
    } else {
      await this.send(
        record,
        MESSAGES.SET_TILE_EFFECT,
        encode.setTileEffect({
          instanceId: randomInt(1, 0x7fffffff),
          type: definition.type,
          speed: speedMs,
          // Flame has its own colours; Morph blends the palette.
          palette: effect === 'morph' ? colors : [],
        }),
      );
    }
    if (!(current.power > 0)) {
      await this.send(
        record,
        MESSAGES.LIGHT_SET_POWER,
        encode.setLightPower({ on: true, duration: transition }),
      );
      record.light = { ...record.light, power: U16 };
    }
    record.effect = effect;
    await this.commandDone(record);
    return { effect };
  }

  /** Stop the firmware effect of a strip or a matrix (OFF of its family). */
  async stopEffect(record) {
    const { caps } = record;
    if (effectsOf(caps).length === 0) {
      throw new Error(`${this.label(record)} has no effect to stop`);
    }
    this.commandStarted(record, 0);
    if (caps.multizone) {
      await this.send(
        record,
        MESSAGES.SET_MULTI_ZONE_EFFECT,
        encode.setMultiZoneEffect({
          instanceId: randomInt(1, 0x7fffffff),
          type: MULTI_ZONE_EFFECTS.OFF,
        }),
      );
    } else {
      await this.send(
        record,
        MESSAGES.SET_TILE_EFFECT,
        encode.setTileEffect({ instanceId: randomInt(1, 0x7fffffff), type: TILE_EFFECTS.OFF }),
      );
    }
    record.effect = NO_EFFECT;
    await this.commandDone(record);
  }

  /**
   * Before a colour or a white: the effect would cover it. Also sent while
   * the running effect is unknown; a firmware without effects ignores it.
   */
  async stopRunningEffect(record) {
    if (effectsOf(record.caps).length === 0 || record.effect === NO_EFFECT) {
      return;
    }
    try {
      await this.stopEffect(record);
    } catch (err) {
      if (err.cause?.kind !== 'unhandled' && err.kind !== 'unhandled') {
        throw err;
      }
    }
  }

  /** How many zones a strip has. */
  async zoneCount(record) {
    const target = this.target(record);
    if (record.caps.extendedMultizone) {
      const reply = await this.transport.request(target, MESSAGES.GET_EXTENDED_COLOR_ZONES, {
        expect: [MESSAGES.STATE_EXTENDED_COLOR_ZONES],
      });
      return reply.data.count;
    }
    const reply = await this.transport.request(target, MESSAGES.GET_COLOR_ZONES, {
      payload: encode.getColorZones(),
      expect: [MESSAGES.STATE_MULTI_ZONE, MESSAGES.STATE_ZONE],
    });
    return reply.data.count;
  }

  /**
   * Spread a palette along a strip, in equal bands: the colours Move slides.
   * Buffered, then applied at once by the last message.
   */
  async paintZones(record, colors) {
    const count = await this.zoneCount(record);
    if (!(count > 0)) {
      return;
    }
    const zones = Array.from(
      { length: count },
      (_, index) => colors[Math.floor((index * colors.length) / count)],
    );
    if (record.caps.extendedMultizone) {
      for (let index = 0; index < count; index += EXTENDED_ZONES_PER_MESSAGE) {
        const last = index + EXTENDED_ZONES_PER_MESSAGE >= count;
        await this.send(
          record,
          MESSAGES.SET_EXTENDED_COLOR_ZONES,
          encode.setExtendedColorZones({
            index,
            colors: zones.slice(index, index + EXTENDED_ZONES_PER_MESSAGE),
            apply: last ? APPLY.APPLY : APPLY.NO_APPLY,
          }),
        );
      }
      return;
    }
    // Legacy strips: one message per band of the same colour.
    const bands = [];
    zones.forEach((color, index) => {
      const band = bands.at(-1);
      if (band && band.color === color) {
        band.end = index;
      } else {
        bands.push({ start: index, end: index, color });
      }
    });
    for (const [at, band] of bands.entries()) {
      await this.send(
        record,
        MESSAGES.SET_COLOR_ZONES,
        encode.setColorZones({
          ...band,
          apply: at === bands.length - 1 ? APPLY.APPLY : APPLY.NO_APPLY,
        }),
      );
    }
  }

  /** What the Configuration screen's "Search" action reports. */
  summary() {
    return {
      scan: this.lastScan.status,
      invalidHosts: this.config.invalidHosts,
      devices: [...this.records.values()].map((record) => ({
        name: deviceName(record),
        host: record.host,
        product: record.caps?.product ?? null,
        reachable: record.reachable === true,
      })),
    };
  }
}

/** A StateService for the UDP service (a light answers once per service). */
function isUdpService(payload) {
  try {
    return decode[MESSAGES.STATE_SERVICE](payload).service === SERVICE_UDP;
  } catch {
    return false;
  }
}
