'use strict';
process.env.GSD_TEST_MODE = '1';

// allow-test-rule: source-text-is-the-product
// update.md's embedded classifier + cache-clear loop are workflow text the
// runtime loads and executes, so asserting on that text tests deployed
// behavior. The runtime/scope detection cascade itself moved out of inline
// bash into the update-context projection (issue #498), so the core guarantee
// is exercised behaviorally against resolveUpdateContext rather than by
// matching a `RUNTIME_DIRS=(...)` literal that no longer lives in update.md.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #503: /gsd:update misclassifies local Antigravity (.agent) installs as claude
 *
 * The installer places a LOCAL Antigravity install in ./.agent/
 * (bin/install.js: getDirName('antigravity') === '.agent'). The /gsd:update
 * detection cascade must map .agent -> antigravity across three surfaces:
 *   1. the execution_context path classifier (update.md prose),
 *   2. the RUNTIME_DIRS candidate table (now in the update-context projection),
 *   3. the post-update cache-clear `for dir in` loop (update.md).
 *
 * Surface (2) is the original root cause and is now verified behaviorally: a
 * LOCAL .agent install must resolve to the antigravity runtime. Before the fix
 * (.agent absent from RUNTIME_DIRS) it fell through to UNKNOWN/claude.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UPDATE_MD = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'update.md'),
  'utf-8',
);
const { resolveUpdateContext } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'),
);

function normKey(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
function fakeFs(files) {
  const set = new Map();
  for (const [k, v] of Object.entries(files)) set.set(normKey(k), v);
  return {
    exists: (p) => set.has(normKey(p)),
    readFile: (p) => { const k = normKey(p); return set.has(k) ? set.get(k) : null; },
  };
}

describe('/gsd:update detects local Antigravity (.agent) installs (#503)', () => {
  test('projection resolves a LOCAL ./.agent install to the antigravity runtime', () => {
    const HOME = '/home/u';
    const CWD = '/work/proj';
    const agentDir = `${CWD}/.agent`;
    const ffs = fakeFs({
      [`${agentDir}/gsd-core/VERSION`]: '1.40.0\n',
      [`${agentDir}/gsd-core/workflows/update.md`]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: ffs });
    assert.equal(
      r.runtime,
      'antigravity',
      `a local .agent install must map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.40.0');
  });

  test('execution_context classifier maps a /.agent/ path to antigravity (update.md)', () => {
    const hasAgentClassifierRule =
      /\/\.agent\/[^\n]*->[^\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentClassifierRule,
      'update.md classifier must map a `/.agent/` path to the `antigravity` runtime',
    );
  });

  test('every runtime-dir `for dir in` loop in update.md includes .agent', () => {
    // The LOCAL-scope discovery loop moved into the projection (#498); the
    // post-update cache-clear loop remains inline and still enumerates the
    // runtime config dirs as a literal `.claude ... .codex` list, so it must
    // include .agent or a local Antigravity install keeps a stale indicator.
    const runtimeDirLoops = UPDATE_MD
      .split('\n')
      .filter((l) => /for dir in .*\.claude.*\.codex/.test(l));
    assert.ok(
      runtimeDirLoops.length >= 1,
      `expected at least 1 runtime-dir loop in update.md, found ${runtimeDirLoops.length}`,
    );
    for (const loop of runtimeDirLoops) {
      assert.ok(
        /(^|\s)\.agent(\s|$)/.test(loop),
        `every runtime-dir loop must include .agent, got: ${loop.trim()}`,
      );
    }
  });
});
