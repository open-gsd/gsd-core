/**
 * Regression test for #1750: orphaned hook files from removed features
 * (e.g., gsd-intel-*.js) should NOT be flagged as stale by gsd-check-update.js.
 *
 * The stale hooks scanner should only check hooks that are part of the current
 * distribution, not every gsd-*.js file in the hooks directory.
 *
 * Migration note (#455): previously used fs.readFileSync + regex on the worker
 * and build-hooks source to extract arrays. Now imports typed exports directly:
 *   - hooks/managed-hooks-registry.cjs  → MANAGED_HOOKS
 *   - scripts/build-hooks.js            → HOOKS_TO_COPY
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CHECK_UPDATE_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update.js');
const WORKER_PATH = path.join(__dirname, '..', 'hooks', 'gsd-check-update-worker.js');
const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

// Typed imports — no source-grep needed (#455)
const { MANAGED_HOOKS } = require(path.join(HOOKS_DIR, 'managed-hooks-registry.cjs'));
const { HOOKS_TO_COPY } = require(path.join(__dirname, '..', 'scripts', 'build-hooks.js'));

describe('orphaned hooks stale detection (#1750)', () => {
  test('MANAGED_HOOKS is an array and does not use a broad gsd-* wildcard', () => {
    // The scanner must reference a known set of managed hook filenames,
    // not a broad startsWith('gsd-') filter that catches orphaned files.
    assert.ok(Array.isArray(MANAGED_HOOKS), 'MANAGED_HOOKS must be an array');
    // Each entry is a concrete filename string — no glob/wildcard patterns
    for (const entry of MANAGED_HOOKS) {
      assert.ok(typeof entry === 'string', `MANAGED_HOOKS entry must be a string, got ${typeof entry}`);
      assert.ok(!entry.includes('*'), `MANAGED_HOOKS entry '${entry}' must not contain wildcards`);
      assert.ok(entry.startsWith('gsd-'), `MANAGED_HOOKS entry '${entry}' must start with gsd-`);
    }
  });

  test('gsd-check-update-worker.js imports managed-hooks-registry.cjs (not inline array)', () => {
    const content = fs.readFileSync(WORKER_PATH, 'utf8');
    assert.ok(
      content.includes('managed-hooks-registry.cjs'),
      'gsd-check-update-worker.js must require managed-hooks-registry.cjs'
    );
    // The inline MANAGED_HOOKS array must no longer be in the worker
    assert.ok(
      !content.includes('const MANAGED_HOOKS = ['),
      'gsd-check-update-worker.js must not define MANAGED_HOOKS inline — it should import from managed-hooks-registry.cjs'
    );
  });

  test('gsd-check-update.js spawns the worker by file path (not inline -e code)', () => {
    const content = fs.readFileSync(CHECK_UPDATE_PATH, 'utf8');
    assert.ok(
      content.includes('gsd-check-update-worker.js'),
      'gsd-check-update.js must reference gsd-check-update-worker.js as the spawn target'
    );
    assert.ok(
      !content.includes("'-e'"),
      'gsd-check-update.js must not use node -e inline code (logic moved to worker file)'
    );
  });

  test('MANAGED_HOOKS includes each JS hook from HOOKS_TO_COPY', () => {
    assert.ok(Array.isArray(HOOKS_TO_COPY), 'HOOKS_TO_COPY must be an array');
    const jsHooks = HOOKS_TO_COPY.filter(h => h.endsWith('.js'));
    assert.ok(jsHooks.length >= 5, `expected at least 5 JS hooks in HOOKS_TO_COPY, got ${jsHooks.length}`);

    for (const hook of jsHooks) {
      assert.ok(
        MANAGED_HOOKS.includes(hook),
        `MANAGED_HOOKS should include '${hook}' from HOOKS_TO_COPY`
      );
    }
  });

  test('orphaned hook filenames are NOT in MANAGED_HOOKS', () => {
    const orphanedHooks = [
      'gsd-intel-index.js',
      'gsd-intel-prune.js',
      'gsd-intel-session.js',
    ];

    for (const orphan of orphanedHooks) {
      assert.ok(
        !MANAGED_HOOKS.includes(orphan),
        `orphaned hook '${orphan}' must NOT be in MANAGED_HOOKS`
      );
    }
  });
});
