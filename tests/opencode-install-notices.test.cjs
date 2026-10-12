'use strict';

/**
 * opencode-install-notices.test.cjs — what the installer tells an operator about the installed OpenCode
 * generation and its data directory (ADR-5331 D2/D6, epic #5331 Phase 1/2). A stand-in `opencode` executable
 * on PATH answers `--version` and `debug paths`; the data directory holds a real SQLite database whose
 * tables mark the generation that migrated it. POSIX-only: the stand-in is a shebang script.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { readInstallState } = require('../gsd-core/bin/lib/installer-migrations.cjs');

let DatabaseSync = null;
try {
  const realWarn = process.emitWarning;
  process.emitWarning = () => undefined;
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = realWarn;
} catch { /* no node:sqlite on this Node */ }

const SKIP = process.platform === 'win32' ? 'POSIX shebang stand-in' : (DatabaseSync ? false : 'node:sqlite unavailable');

function sandbox(t, { version, tables }) {
  const home = createTempDir('gsd-oc-notice-');
  t.after(() => cleanup(home));
  const dataDir = path.join(home, 'data', 'opencode');
  fs.mkdirSync(dataDir, { recursive: true });
  if (tables) {
    const db = new DatabaseSync(path.join(dataDir, 'opencode.db'));
    for (const name of tables) db.exec(`create table ${name} (id integer)`);
    db.close();
  }
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const shim = path.join(bin, 'opencode');
  fs.writeFileSync(shim, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') console.log(${JSON.stringify(version)});
else if (a[0] === 'debug' && a[1] === 'paths') console.log('data       ' + ${JSON.stringify(dataDir)});
`);
  fs.chmodSync(shim, 0o755);
  const configDir = path.join(home, 'cfg', 'opencode');
  return { home, bin, configDir, dataDir };
}

function install({ home, bin, configDir }) {
  const result = runNode([INSTALL_SCRIPT, '--opencode', '--global', '--config-dir', configDir], {
    env: installerEnv({ HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  assert.strictEqual(result.exitCode, 0, `installer failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('1.x installed over a data dir 2.x created: the installer warns and records generation 1', { skip: SKIP }, (t) => {
  const sb = sandbox(t, { version: '1.19.0', tables: ['project', 'session_v2', 'session_inbox'] });
  const out = install(sb);
  assert.match(out, /OpenCode 1\.19\.0 detected/);
  assert.match(out, /was created by OpenCode 2\.x/);
  assert.match(out, /never modifies this database/);
  assert.deepEqual(readInstallState(sb.configDir).hostGeneration, { runtime: 'opencode', generation: 1, version: '1.19.0' });
});

test('2.x installed over a 1.x data dir: the installer says 1.x keeps opening it and records generation 2', { skip: SKIP }, (t) => {
  const sb = sandbox(t, { version: 'opencode v2.0.27', tables: ['project', 'session', 'message'] });
  const out = install(sb);
  assert.match(out, /OpenCode 2\.0\.27 detected/);
  assert.match(out, /will add its own tables/);
  assert.match(out, /1\.x still opens it/);
  assert.deepEqual(readInstallState(sb.configDir).hostGeneration, { runtime: 'opencode', generation: 2, version: '2.0.27' });
});

test('matching generation and data dir: no data-directory notice', { skip: SKIP }, (t) => {
  const sb = sandbox(t, { version: '2.0.27', tables: ['project', 'session_v2'] });
  const out = install(sb);
  assert.match(out, /OpenCode 2\.0\.27 detected/);
  assert.doesNotMatch(out, /data directory/);
});

test('1.x installed over a data dir holding both generations\' tables: informational only', { skip: SKIP }, (t) => {
  const sb = sandbox(t, { version: '1.19.0', tables: ['project', 'session', 'session_v2'] });
  const out = install(sb);
  assert.match(out, /has also used the data directory/);
  assert.doesNotMatch(out, /cannot open it/);
});
