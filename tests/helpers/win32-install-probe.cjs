'use strict';

/**
 * Faked-win32 installer child (#5100, #5850, #5888).
 *
 * Several tests present a child process as win32 (`process.platform` is a configurable own property)
 * and then require `bin/install.js`. That child still inherits the real host, and the installer's
 * load-time WSL check (`bin/install.js`, "Detected WSL with Windows-native Node.js") reads two host
 * signals: `WSL_DISTRO_NAME`, then `/proc/version` naming "microsoft" or "wsl". On a WSL host either
 * one makes the child exit 1 before `install()` runs, so every such test went red there (#5888).
 *
 * `runWin32InstallerChild` is the one spawn scaffold for those children: a temp HOME cleaned up with
 * the test, the sandboxed install env, and (unless `isolateWsl: false`) both WSL signals hidden from
 * the child. `FAKE_WSL_HOST_PREAMBLE` makes any host present both signals, so a test can prove the
 * isolation on a non-WSL host too.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup, installSpawnEnv } = require('../helpers.cjs');
const { isolatedEnv } = require('./isolated-env.cjs');
const { runNode } = require('./process-seam.cjs');
const { INSTALL_TIMEOUT_MS } = require('./timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PROC_VERSION = '/proc/version';
const PROBE_JSON_MARKER = 'PROBE_JSON ';
// What the installer's load-time WSL check prints before it exits 1 (`bin/install.js`).
const WSL_WARNING_PATTERN = /Detected WSL with Windows-native Node\.js/;

// Child source. Hides /proc/version from existsSync, so the installer's WSL check skips the read.
const HIDE_PROC_VERSION = `
{
  const wslFs = require('node:fs');
  const wslExistsSync = wslFs.existsSync;
  wslFs.existsSync = (p) => (String(p) === ${JSON.stringify(PROC_VERSION)} ? false : wslExistsSync(p));
}
`;

// Child source. Makes /proc/version exist and name a WSL2 kernel, whatever the host is.
const FAKE_WSL_HOST_PREAMBLE = `
{
  const hostFs = require('node:fs');
  const hostExistsSync = hostFs.existsSync;
  const hostReadFileSync = hostFs.readFileSync;
  hostFs.existsSync = (p) => (String(p) === ${JSON.stringify(PROC_VERSION)} ? true : hostExistsSync(p));
  hostFs.readFileSync = (p, ...rest) => (
    String(p) === ${JSON.stringify(PROC_VERSION)}
      ? 'Linux version 5.15.167.4-microsoft-standard-WSL2 (gcc) #1 SMP'
      : hostReadFileSync(p, ...rest)
  );
}
`;

/**
 * Spawn `source` (child JS that fakes win32 and requires the installer) with a fresh temp HOME.
 *
 * - `preamble` runs first, so the isolation stub and `source`'s own fs stubs wrap whatever it
 *   installs (a fake WSL host must be wrapped, not the other way round).
 * - `env` (an object, or a function of the temp HOME) is merged over the base env; it can stand in
 *   for host variables (e.g. a WSL host's `WSL_DISTRO_NAME`) without touching the parent's
 *   `process.env`.
 * - `isolateWsl` (default true) blanks `WSL_DISTRO_NAME` after `env` and hides /proc/version.
 *
 * Returns the process-seam result plus `home`.
 */
function runWin32InstallerChild(t, source, { preamble = '', env = {}, isolateWsl = true, tmpPrefix = 'gsd-win32-install-' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  t.after(() => cleanup(home));
  // Joined with newlines so no part depends on another starting or ending with one.
  const childSource = [preamble, isolateWsl ? HIDE_PROC_VERSION : '', source].join('\n');
  const result = runNode(['-e', childSource], {
    cwd: REPO_ROOT,
    env: installSpawnEnv(isolatedEnv({
      home,
      override: {
        PROBE_REPO: REPO_ROOT,
        GSD_TEST_MODE: '1',
        ...(typeof env === 'function' ? env(home) : env),
        ...(isolateWsl ? { WSL_DISTRO_NAME: '' } : {}),
      },
    })),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  return { ...result, home };
}

/** The `PROBE_JSON {...}` line the child wrote to stdout, parsed, or null when there is none. */
function readProbeJson(result) {
  const line = result.stdout.split('\n').find((entry) => entry.startsWith(PROBE_JSON_MARKER));
  return line ? JSON.parse(line.slice(PROBE_JSON_MARKER.length)) : null;
}

module.exports = {
  FAKE_WSL_HOST_PREAMBLE,
  WSL_WARNING_PATTERN,
  runWin32InstallerChild,
  readProbeJson,
};
