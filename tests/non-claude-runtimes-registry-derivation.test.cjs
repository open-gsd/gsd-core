'use strict';
/**
 * Drift-guard: NON_CLAUDE_RUNTIMES must always be derived from the capability
 * registry. Verifies:
 *   1. The exported constant equals a hardcoded golden expected list — a pinned
 *      oracle that catches BOTH formula bugs (derived value diverges from golden)
 *      AND unintended registry drift (adding/removing a runtime forces a
 *      deliberate golden-list update).
 *   2. Every registry entry with role === 'runtime' and id !== 'claude' appears
 *      in NON_CLAUDE_RUNTIMES — a cross-check from a different angle than the
 *      production derivation formula.
 *   3. Every member of NON_CLAUDE_RUNTIMES has an explicit getDirName branch that
 *      does not return '.claude' — guards against adding a runtime to the registry
 *      without teaching getDirName about it (ADR-1239 Phase B, #1679).
 *
 * Behavioral tests only: assert on returned values, no source-grep.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');

const { NON_CLAUDE_RUNTIMES } = conversion;
const { getDirName, NO_LOCAL_CONFIG_DIR_SENTINEL } = runtimeNamePolicy;

// Golden oracle: hardcoded sorted known-good list of all non-Claude runtimes.
// A pinned expected value in a TEST is correct — the test IS the oracle.
// EXPECTED is DERIVED from the capability registry (the single source of truth)
// so this guard stays fluid when a runtime is added or removed. The contract
// being pinned is the DERIVATION (NON_CLAUDE_RUNTIMES === registry runtimes −
// claude), not a frozen per-runtime snapshot.
const EXPECTED = Object.keys(registry.runtimes)
  .filter((id) => id !== 'claude')
  .sort();

test('NON_CLAUDE_RUNTIMES matches the golden expected set (sorted)', () => {
  assert.deepEqual(
    [...NON_CLAUDE_RUNTIMES],
    EXPECTED,
    `NON_CLAUDE_RUNTIMES diverged from golden list.\n` +
    `  actual:   [${[...NON_CLAUDE_RUNTIMES].join(', ')}]\n` +
    `  expected: [${EXPECTED.join(', ')}]`,
  );
  // Explicit readability assertion: 'claude' must never appear.
  assert.ok(
    !NON_CLAUDE_RUNTIMES.includes('claude'),
    'NON_CLAUDE_RUNTIMES must not contain "claude"',
  );
});

test('every registry-declared runtime except claude is present in NON_CLAUDE_RUNTIMES', () => {
  // Cross-check from a DIFFERENT angle than the production derivation formula:
  // iterate registry entries by their role field rather than by Object.keys().filter().
  // This catches a case where a runtime is added to the registry with role==='runtime'
  // but is somehow excluded from NON_CLAUDE_RUNTIMES by a formula bug.
  for (const [id, entry] of Object.entries(registry.runtimes)) {
    if (entry.role === 'runtime' && id !== 'claude') {
      assert.ok(
        NON_CLAUDE_RUNTIMES.includes(id),
        `Registry declares runtime '${id}' (role==='runtime') but it is missing from NON_CLAUDE_RUNTIMES`,
      );
    }
  }
});

// Forward direction (registry → getDirName coverage) is the load-bearing guard:
// the registry is the authoritative runtime source, so every member of
// NON_CLAUDE_RUNTIMES must have an explicit getDirName branch.
test('DRIFT GUARD: every registry-declared non-Claude runtime has an explicit getDirName branch (not .claude)', () => {
  for (const rt of NON_CLAUDE_RUNTIMES) {
    const dir = getDirName(rt);
    assert.notEqual(
      dir,
      '.claude',
      `getDirName('${rt}') returned '.claude' — runtime '${rt}' is in the registry but missing an explicit getDirName branch`,
    );
  }
});

// #2103: vscode is a registry runtime (role:runtime) whose configHome.kind is
// 'none' — it has NO file-projected config directory at all (Marketplace/VSIX
// extension). It is covered by the generic loop above (its dir must not be
// '.claude'), but that assertion alone would ALSO pass for a plain string
// typo, so this pins the actual documented sentinel value honestly rather
// than riding on the generic "not .claude" check.
test('#2103: getDirName("vscode") returns the documented no-local-config-dir sentinel, not .claude and not a real dot-dir', () => {
  assert.ok(NON_CLAUDE_RUNTIMES.includes('vscode'), 'vscode must be a registered non-Claude runtime');
  const dir = getDirName('vscode');
  assert.equal(dir, NO_LOCAL_CONFIG_DIR_SENTINEL);
  assert.notEqual(dir, '.claude');
  assert.ok(!dir.startsWith('.'), 'the sentinel must not look like a plausible dot-dir name');
});
