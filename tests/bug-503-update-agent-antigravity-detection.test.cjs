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

describe('/gsd:update detects local Antigravity (.agent / .agents) installs (#503 / #791)', () => {
  test('projection resolves a LOCAL ./.agents install to the antigravity runtime (#791 canonical)', () => {
    const HOME = '/home/u';
    const CWD = '/work/proj';
    const agentsDir = `${CWD}/.agents`;
    const ffs = fakeFs({
      [`${agentsDir}/gsd-core/VERSION`]: '1.50.0\n',
      [`${agentsDir}/gsd-core/workflows/update.md`]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: ffs });
    assert.equal(
      r.runtime,
      'antigravity',
      `a local .agents install must map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.50.0');
  });

  test('projection resolves a LOCAL ./.agent install to the antigravity runtime (#503 backward-compat)', () => {
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
      `a legacy .agent install must still map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.40.0');
  });

  test('execution_context classifier maps /.agents/ and /.agent/ paths to antigravity (update.md)', () => {
    const hasAgentsClassifierRule =
      /\/\.agents\/[^\n]*->[^\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentsClassifierRule,
      'update.md classifier must map a `/.agents/` path to the `antigravity` runtime',
    );
    const hasAgentClassifierRule =
      /\/\.agent\/[^\n]*->[^\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentClassifierRule,
      'update.md classifier must still map a `/.agent/` path to the `antigravity` runtime (backward-compat)',
    );
  });

  test('every runtime-dir `for dir in` loop in update.md includes .agents and .agent', () => {
    // The LOCAL-scope discovery loop moved into the projection (#498); the
    // post-update cache-clear loop remains inline and still enumerates the
    // runtime config dirs as a literal `.claude ... .codex` list, so it must
    // include both .agents (canonical, #791) and .agent (legacy, #503) or
    // stale indicators could linger.
    const runtimeDirLoops = UPDATE_MD
      .split('\n')
      .filter((l) => /for dir in .*\.claude.*\.codex/.test(l));
    assert.ok(
      runtimeDirLoops.length >= 1,
      `expected at least 1 runtime-dir loop in update.md, found ${runtimeDirLoops.length}`,
    );
    for (const loop of runtimeDirLoops) {
      assert.ok(
        /(^|\s)\.agents(\s|$)/.test(loop),
        `every runtime-dir loop must include .agents (canonical), got: ${loop.trim()}`,
      );
      assert.ok(
        /(^|\s)\.agent(\s|$)/.test(loop),
        `every runtime-dir loop must include .agent (legacy backward-compat), got: ${loop.trim()}`,
      );
    }
  });
});
