// allow-test-rule: source-text-is-the-product
// update.md is a workflow file whose text IS the contract the runtime loads
// and executes (the embedded bash detection cascade). Asserting on its text
// tests the deployed behavior. Per CONTRIBUTING.md exception matrix.

/**
 * Bug #503: /gsd:update misclassifies local Antigravity (.agent) installs as claude
 *
 * The installer places a LOCAL Antigravity install in ./.agent/
 * (bin/install.js: getDirName('antigravity') === '.agent'). But the
 * /gsd:update detection cascade in get-shit-done/workflows/update.md only
 * knew the GLOBAL Antigravity layout (.gemini/antigravity{,-ide,-cli}), so a
 * local .agent install fell through to the `Otherwise -> claude` default and
 * the update refreshed Claude artifacts instead of the Antigravity install.
 *
 * The cascade has three coupled detection surfaces; .agent must be mapped to
 * antigravity in all three:
 *   1. the execution_context path classifier,
 *   2. the RUNTIME_DIRS candidate array,
 *   3. the LOCAL-scope discovery `for dir in ...` loop.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UPDATE_MD = fs.readFileSync(
  path.join(__dirname, '..', 'get-shit-done', 'workflows', 'update.md'),
  'utf-8'
);

describe('/gsd:update detects local Antigravity (.agent) installs (#503)', () => {
  test('execution_context classifier maps a /.agent/ path to antigravity', () => {
    // A rule line of the form: Path contains `/.agent/` -> `antigravity`
    const hasAgentClassifierRule =
      /\/\.agent\/[^\n]*->[^\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentClassifierRule,
      'update.md classifier must map a `/.agent/` path to the `antigravity` runtime'
    );
  });

  test('RUNTIME_DIRS candidate array includes antigravity:.agent', () => {
    const runtimeDirsLine = UPDATE_MD
      .split('\n')
      .find((l) => l.includes('RUNTIME_DIRS=('));
    assert.ok(runtimeDirsLine, 'RUNTIME_DIRS array must exist in update.md');
    assert.ok(
      runtimeDirsLine.includes('antigravity:.agent'),
      `RUNTIME_DIRS must contain "antigravity:.agent", got: ${runtimeDirsLine}`
    );
  });

  test('every runtime-dir `for dir in` loop includes .agent', () => {
    // Both the LOCAL-scope discovery loop AND the post-update cache-clear loop
    // enumerate the runtime config dirs as a literal `.claude ... .codex` list.
    // The same root cause (.agent missing from the runtime-dir list) breaks
    // detection in the first and leaves a stale update indicator in the second,
    // so ALL such loops must include .agent.
    const runtimeDirLoops = UPDATE_MD
      .split('\n')
      .filter((l) => /for dir in .*\.claude.*\.codex/.test(l));
    assert.ok(
      runtimeDirLoops.length >= 2,
      `expected at least 2 runtime-dir loops in update.md, found ${runtimeDirLoops.length}`
    );
    for (const loop of runtimeDirLoops) {
      assert.ok(
        /(^|\s)\.agent(\s|$)/.test(loop),
        `every runtime-dir loop must include .agent, got: ${loop.trim()}`
      );
    }
  });
});
