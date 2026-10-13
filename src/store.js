// -----------------------------------------------------------------------------
// Small persistence under /data (the only writable path of the container): the
// LIFX devices seen so far, with their address, product and firmware, so a
// restart knows them before the first scan and their devices stay in the
// Discovery list while they are switched off at the wall. Nothing secret: the
// LIFX LAN protocol has no key. Losing the file is harmless: the next scan
// rebuilds it.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ProblemLog } from './problems.js';

const logger = createLogger({ name: 'lifx-store' });
const FILE_NAME = 'lifx-state.json';

export class Store {
  constructor(directory = process.env.LIFX_DATA_DIR || '/data') {
    this.directory = directory;
    this.path = join(directory, FILE_NAME);
    this.pending = null;
    // A volume that refuses writes is said once, not at every scan.
    this.problems = new ProblemLog(logger);
    this.writing = null;
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.path}: ${err.message}`);
      }
      return {};
    }
  }

  // Writes are coalesced and atomic (temporary file + rename): a crash never
  // leaves half a JSON file behind.
  save(data) {
    this.latest = data;
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.latest;
        this.pending = null;
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot));
          await rename(temporary, this.path);
          this.problems.recover('write', `${this.path} is written again`);
        } catch (err) {
          this.problems.fail('write', `Cannot write ${this.path}: ${err.message}`);
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /** Resolves once every write requested so far is on disk. */
  flush() {
    return this.writing ?? Promise.resolve();
  }
}
