'use strict';

/**
 * #5681 — a temp GSD_HOME holding the global defaults store,
 * `$GSD_HOME/.gsd/defaults.json`, for the config-save-defaults and
 * new-project suites (`tests/config.test.cjs`, `tests/config.platform.test.cjs`).
 *
 * `contents` is written as it is when a string, else as JSON; `undefined`
 * writes no file. The `.gsd/` directory is made whenever a file is written,
 * and with `makeDir` when none is (a test that puts a FIFO or a link there).
 * The home is removed after the test.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('../helpers.cjs');

function defaultsStoreHome(t, contents, { makeDir = false } = {}) {
  const gsdHome = createTempDir('gsd-5681-home-');
  t.after(() => cleanup(gsdHome));
  const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
  if (contents !== undefined || makeDir) fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
  if (contents !== undefined) {
    fs.writeFileSync(defaultsPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return { gsdHome, defaultsPath };
}

module.exports = { defaultsStoreHome };
