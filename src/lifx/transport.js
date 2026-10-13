// -----------------------------------------------------------------------------
// The LIFX LAN client: binary packets on UDP (port 56700), one request, one
// reply. A Get is answered by its State message, a Set sent with
// `ack_required` by an Acknowledgement. No account, no key.
//
// One socket for every device, bound on an ephemeral port: the devices answer
// to the address and port the request came from, which crosses the Docker
// bridge. A reply is matched on the device address, our source identifier and
// the sequence number it echoes. UDP loses datagrams: a request is sent again
// with a growing delay until its reply or the deadline (the same sequence
// number, so late copies of a reply are ignored). One request at a time per
// device, which keeps far below the 20 messages per second LIFX asks clients
// not to exceed.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import { LIFX_PORT, MESSAGES, decode, decodePacket, encodePacket } from './packet.js';

export const TRANSPORT_TIMINGS = {
  // Total wait for a reply (reads, discovery probes).
  timeoutMs: 3_000,
  // Commands: the user waits, but a lost datagram should not fail them.
  commandTimeoutMs: 5_000,
  firstRetryMs: 400,
  maxRetryMs: 1_500,
};

export class LifxError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {'timeout'|'unhandled'|'malformed'|'socket'} [details.kind]
   */
  constructor(message, { kind = 'malformed' } = {}) {
    super(message);
    this.name = 'LifxError';
    this.kind = kind;
  }

  /** No answer: the device is off, unplugged or gone. */
  get unreachable() {
    return this.kind === 'timeout' || this.kind === 'socket';
  }
}

export class LifxTransport {
  /**
   * @param {object} [options]
   * @param {() => object} [options.createSocket] test seam: a dgram-like socket
   * @param {object} [options.timings] TRANSPORT_TIMINGS overrides
   * @param {number} [options.source] client identifier (random otherwise)
   * @param {object} [options.logger]
   */
  constructor({ createSocket, timings, source, logger } = {}) {
    this.createSocket = createSocket ?? (() => dgram.createSocket('udp4'));
    this.timings = { ...TRANSPORT_TIMINGS, ...timings };
    // Non-zero: a zero source asks the devices to broadcast their replies.
    this.source = source ?? randomInt(2, 0x7fffffff);
    this.logger = logger;
    this.socket = null;
    this.opening = null;
    /** @type {Map<string, object>} requests waiting, by `${address}|${sequence}` */
    this.pending = new Map();
    /** @type {Map<string, Promise>} tail of the requests of each device */
    this.queues = new Map();
    // One counter for every device: two requests in flight never share a
    // number, even for two devices behind one address.
    this.sequence = randomInt(0, 256);
    this.closed = false;
  }

  /** Bind the socket (once). */
  open() {
    if (this.socket) {
      return Promise.resolve();
    }
    this.opening ??= new Promise((resolve, reject) => {
      const socket = this.createSocket();
      const onError = (err) => {
        this.opening = null;
        reject(new LifxError(`Cannot open the UDP socket: ${err.message}`, { kind: 'socket' }));
      };
      socket.once('error', onError);
      socket.on('message', (message, remote) => this.receive(message, remote));
      socket.bind(0, () => {
        socket.off('error', onError);
        socket.on('error', (err) => this.logger?.warn(`UDP socket error: ${err.message}`));
        // Never keep the process alive for the socket alone.
        socket.unref?.();
        this.socket = socket;
        resolve();
      });
    });
    return this.opening;
  }

  close() {
    this.closed = true;
    for (const waiting of this.pending.values()) {
      waiting.resolve({ closed: true });
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = null;
    this.opening = null;
  }

  receive(message, remote) {
    const packet = decodePacket(message);
    if (!packet || packet.source !== this.source) {
      this.logger?.debug(`Ignored a datagram that is not a reply from ${remote?.address}`);
      return;
    }
    const key = `${remote.address}|${packet.sequence}`;
    const waiting = this.pending.get(key);
    if (!waiting) {
      return;
    }
    if (packet.type === MESSAGES.STATE_UNHANDLED || waiting.expect.includes(packet.type)) {
      if (waiting.accept && packet.type !== MESSAGES.STATE_UNHANDLED && !waiting.accept(packet)) {
        return;
      }
      this.pending.delete(key);
      waiting.resolve({ packet });
    }
  }

  nextSequence() {
    this.sequence = (this.sequence + 1) & 0xff;
    return this.sequence;
  }

  /**
   * Send one message to a device and resolve with the decoded reply.
   * @param {{ host: string, port?: number, serial?: string|null }} device
   * @param {number} type message type
   * @param {object} [options]
   * @param {Buffer} [options.payload]
   * @param {number[]} [options.expect] reply types; an Acknowledgement for a Set
   * @param {(packet: object) => boolean} [options.accept] filter on the replies
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ type: number, target: string, data: object }>}
   */
  request(device, type, options = {}) {
    const deviceKey = `${device.host}:${device.port ?? LIFX_PORT}`;
    const previous = this.queues.get(deviceKey) ?? Promise.resolve();
    const run = previous.then(() => this.exchange(device, type, options));
    const tail = run.catch(() => {});
    this.queues.set(deviceKey, tail);
    tail.then(() => {
      if (this.queues.get(deviceKey) === tail) {
        this.queues.delete(deviceKey);
      }
    });
    return run;
  }

  /** A Set acknowledged by the device (sent again until it is). */
  command(device, type, payload) {
    return this.request(device, type, {
      payload,
      expect: [MESSAGES.ACKNOWLEDGEMENT],
      timeoutMs: this.timings.commandTimeoutMs,
    });
  }

  async exchange(device, type, options) {
    const { payload, expect = [], accept, timeoutMs = this.timings.timeoutMs } = options;
    if (this.closed) {
      throw new LifxError('The integration is stopping', { kind: 'socket' });
    }
    await this.open();
    const port = device.port ?? LIFX_PORT;
    const sequence = this.nextSequence();
    const ack = expect.includes(MESSAGES.ACKNOWLEDGEMENT);
    const data = encodePacket({
      type,
      payload,
      source: this.source,
      sequence,
      target: device.serial ?? null,
      ackRequired: ack,
      resRequired: !ack,
    });
    const key = `${device.host}|${sequence}`;
    let retryTimer = null;
    let deadline = null;
    let entry = null;
    const outcome = await new Promise((resolve) => {
      entry = { resolve, expect, accept };
      this.pending.set(key, entry);
      let delay = this.timings.firstRetryMs;
      const send = () => {
        this.socket?.send(data, port, device.host, (err) => {
          if (err) {
            this.logger?.debug(`Cannot send message ${type} to ${device.host}: ${err.message}`);
          }
        });
        retryTimer = setTimeout(send, delay);
        delay = Math.min(delay * 2, this.timings.maxRetryMs);
      };
      deadline = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      send();
    });
    clearTimeout(retryTimer);
    clearTimeout(deadline);
    if (this.pending.get(key) === entry) {
      this.pending.delete(key);
    }
    if (outcome.closed) {
      throw new LifxError('The integration is stopping', { kind: 'socket' });
    }
    if (outcome.timeout) {
      throw new LifxError(`${device.host} did not answer message ${type}`, { kind: 'timeout' });
    }
    const { packet } = outcome;
    if (packet.type === MESSAGES.STATE_UNHANDLED) {
      throw new LifxError(`${device.host} does not handle message ${type}`, {
        kind: 'unhandled',
      });
    }
    let decoded;
    try {
      decoded = decode[packet.type]?.(packet.payload) ?? {};
    } catch (err) {
      throw new LifxError(`${device.host} answered message ${type} badly: ${err.message}`);
    }
    return { type: packet.type, target: packet.target, data: decoded };
  }
}
