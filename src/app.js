// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake) and
// returns the hub, so index.js stays a few lines and the tests drive the very
// same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { LifxHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { INIT_FAILED, searchMessage } from './texts.js';
import { LifxTransport } from './lifx/transport.js';

const logger = createLogger({ name: 'lifx-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, createSocket, timers, timings, transportTimings, now
 */
export function registerHandlers(gladys, options = {}) {
  const transport = new LifxTransport({
    createSocket: options.createSocket,
    timings: options.transportTimings,
    logger: createLogger({ name: 'lifx-udp' }),
  });
  const hub = new LifxHub({
    gladys,
    store: options.store ?? new Store(),
    transport,
    timers: options.timers ?? true,
    timings: options.timings,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first scan is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): re-sync what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  // The devices are published with should_poll: false (read by the hub's own
  // timer); this only serves a Gladys that would poll anyway, and skips a
  // light the timer read less than half a period ago.
  gladys.onPoll(
    whenReady(async (device) => {
      const record = hub.resolveDevice(device?.external_id);
      if (record) {
        await hub.refresh(record, { minGap: 0.5 });
      }
    }),
  );

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'search',
    whenReady(async () => {
      logger.info('Search for LIFX lights asked from the configuration');
      await hub.rediscover();
      return searchMessage(hub.summary());
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
