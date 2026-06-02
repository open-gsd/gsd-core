/**
 * Tests for the Windows npm resolution platform gate.
 *
 * Background (issue #3103, PR #3102):
 *   On Windows, `npm` ships as `npm.cmd`. Node's spawn does not apply PATHEXT
 *   resolution and fails with ENOENT. The fix is to spawn through a shell on
 *   Windows (cmd.exe resolves npm.cmd via PATHEXT). On POSIX, `npm` resolves
 *   without a shell, so spawning `/bin/sh -c` is pure overhead and changes
 *   signal / exit-code semantics — undesirable.
 *
 * Relocation (#498): the SessionStart worker no longer spawns npm itself. It
 * delegates the latest-version lookup to check-latest-version's
 * `checkLatestVersion()`, which routes through `execNpm` in the shell-command
 * projection seam. The PR #3102 contract therefore now lives on `execNpm`.
 * This test locks it there, and additionally locks that the worker does NOT
 * re-introduce a direct npm spawn (which would re-open the gate question in a
 * second place).
 *
 * Source-grep policy: these structural assertions read source via readFileSync.
 * The behavior (Windows-only shell resolution) is platform-gated at runtime and
 * cannot be reached on POSIX CI without a Windows lane; a structural assertion
 * is the minimum-cost contract.
 */

// allow-test-rule: structural assertion on spawn-options shape; the behavior
// (Windows-only shell resolution) is platform-gated at runtime and cannot be
// reached on POSIX CI without a Windows lane.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');
const PROJECTION_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs',
);

function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('execNpm: Windows npm spawn platform gate (PR #3102, relocated #498)', () => {
  test('projection seam exists', () => {
    assert.ok(fs.existsSync(PROJECTION_PATH), `not found at ${PROJECTION_PATH}`);
  });

  test('execNpm gates shell to process.platform === "win32"', () => {
    assert.match(
      codeOnly(PROJECTION_PATH),
      /shell:\s*process\.platform\s*===\s*['"]win32['"]/,
      [
        'execNpm must gate shell to `process.platform === "win32"`.',
        'A regression to `shell: true` would spawn /bin/sh -c on POSIX',
        '(adds shell overhead, changes signal/exit semantics). See PR #3102.',
      ].join(' '),
    );
  });

  test('no unconditional shell: true on the npm spawn', () => {
    assert.doesNotMatch(
      codeOnly(PROJECTION_PATH),
      /shell\s*:\s*true\s*[,\s}]/,
      'shell: true is forbidden — use the `process.platform === "win32"` gate.',
    );
  });
});

describe('worker delegates the npm spawn (does not re-open the gate, #498)', () => {
  test('worker does NOT spawn npm directly', () => {
    const code = codeOnly(WORKER_PATH);
    assert.doesNotMatch(
      code,
      /(execFileSync|spawnSync|execSync|exec)\s*\(\s*['"]npm['"]/,
      'Worker must delegate to checkLatestVersion(), not spawn npm itself.',
    );
  });

  test('worker requires check-latest-version for the lookup', () => {
    assert.match(codeOnly(WORKER_PATH), /check-latest-version/);
  });
});
