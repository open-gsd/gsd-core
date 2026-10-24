'use strict';

/**
 * Preload fixture for #5037: record the `code` of the uncaught error that ends
 * a spawned script, so a test can tell which refusal stopped it by a typed
 * value instead of matching the error text Node prints on stderr.
 *
 * Loaded with `node --require <this file> <script>` (the same one-shot
 * `--require` seam tests/helpers/spawn-timeout-recorder.cjs uses). Inert unless
 * `GSD_UNCAUGHT_ERROR_RECORD_FILE` names a file. It listens on
 * `uncaughtExceptionMonitor`, which observes the error without handling it, so
 * Node still prints the error and exits 1 exactly as it would without the
 * preload. The record is one JSON object, `{ "code": <string|null> }`, written
 * synchronously before the process exits; no record means no uncaught error.
 */

const fs = require('fs');

const recordFile = process.env.GSD_UNCAUGHT_ERROR_RECORD_FILE;

if (recordFile) {
  process.on('uncaughtExceptionMonitor', (err) => {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : null;
    fs.writeFileSync(recordFile, JSON.stringify({ code }));
  });
}
