/**
 * Regression tests for bug #2136
 *
 * gsd-check-update-worker.js uses a MANAGED_HOOKS array (now in the shared
 * managed-hooks-registry.cjs module) to detect stale hooks after a GSD update.
 * It must list every hook file that GSD ships so that all deployed hooks are
 * checked for staleness — not just the .js ones.
 *
 * The original bug: the 3 bash hooks (gsd-phase-boundary.sh,
 * gsd-session-state.sh, gsd-validate-commit.sh) were missing from
 * MANAGED_HOOKS, so they would never be detected as stale after an update.
 *
 * Migration note (#455): previously used fs.readFileSync + regex on the worker
 * source to extract the array. Now requires the typed export directly from
 * hooks/managed-hooks-registry.cjs.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
// Typed import — no source-grep needed (#455)
const { MANAGED_HOOKS } = require(path.join(HOOKS_DIR, 'managed-hooks-registry.cjs'));

describe('bug #2136: MANAGED_HOOKS must include all shipped hook files', () => {
  // List all GSD-managed hook files in hooks/ (names starting with "gsd-")
  const shippedHooks = fs.readdirSync(HOOKS_DIR)
    .filter(f => f.startsWith('gsd-') && (f.endsWith('.js') || f.endsWith('.sh')));

  test('MANAGED_HOOKS is a non-empty array', () => {
    assert.ok(Array.isArray(MANAGED_HOOKS), 'MANAGED_HOOKS must be an array');
    assert.ok(MANAGED_HOOKS.length > 0, 'MANAGED_HOOKS must not be empty');
  });

  test('every shipped gsd-*.js hook is in MANAGED_HOOKS', () => {
    const jsHooks = shippedHooks.filter(f => f.endsWith('.js'));
    for (const hookFile of jsHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hookFile),
        `${hookFile} is shipped in hooks/ but missing from MANAGED_HOOKS in managed-hooks-registry.cjs`
      );
    }
  });

  test('every shipped gsd-*.sh hook is in MANAGED_HOOKS', () => {
    const shHooks = shippedHooks.filter(f => f.endsWith('.sh'));
    for (const hookFile of shHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hookFile),
        `${hookFile} is shipped in hooks/ but missing from MANAGED_HOOKS in managed-hooks-registry.cjs`
      );
    }
  });

  test('MANAGED_HOOKS contains no entries for hooks that do not exist', () => {
    for (const entry of MANAGED_HOOKS) {
      const exists = fs.existsSync(path.join(HOOKS_DIR, entry));
      assert.ok(
        exists,
        `MANAGED_HOOKS entry '${entry}' has no corresponding file in hooks/ — remove stale entry`
      );
    }
  });
});
