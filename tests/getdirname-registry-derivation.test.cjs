'use strict';
/**
 * Drift-guard: getDirName must be derived from the capability registry.
 * Verifies:
 *   1. For every known runtime id, getDirName(id) equals the hardcoded golden
 *      expected map — a pinned oracle that catches BOTH formula bugs AND
 *      unintended registry drift (adding/removing a runtime or changing its
 *      localConfigDir forces a deliberate golden-map update here).
 *   2. getDirName('unknown') and getDirName('') fall back to '.claude'.
 *   3. Every registry runtime entry has a non-empty dot-dir localConfigDir string —
 *      cross-check from a different angle than the production derivation formula.
 *
 * ADR-1239 Phase B (#1679).
 * Behavioral tests only: assert on returned values, no source-grep.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { getDirName } = runtimeNamePolicy;

// Golden oracle: hardcoded expected map of all 15 runtime ids to their local config dir.
// A pinned expected value in a TEST is correct — the test IS the oracle (non-circular).
// Only PRODUCTION code should derive dynamically from the registry.
// If this map diverges from getDirName output, either the formula is wrong
// OR the registry changed — both require a deliberate golden-map update here.
const GOLDEN_DIR_MAP = {
  claude:      '.claude',
  copilot:     '.github',
  opencode:    '.opencode',
  kilo:        '.kilo',
  codex:       '.codex',
  antigravity: '.agents',
  cursor:      '.cursor',
  windsurf:    '.windsurf',
  augment:     '.augment',
  trae:        '.trae',
  qwen:        '.qwen',
  hermes:      '.hermes',
  kimi:        '.kimi-code',
  codebuddy:   '.codebuddy',
  cline:       '.cline',
};

test('getDirName: golden map matches for all 15 known runtime ids', () => {
  for (const [id, expected] of Object.entries(GOLDEN_DIR_MAP)) {
    const actual = getDirName(id);
    assert.strictEqual(
      actual,
      expected,
      `getDirName('${id}') diverged from golden.\n` +
      `  actual:   ${JSON.stringify(actual)}\n` +
      `  expected: ${JSON.stringify(expected)}`,
    );
  }
});

test('drift guard: registry runtime id set EXACTLY equals the golden map (adding/removing a runtime forces a golden update)', () => {
  // Without this, a newly-added runtime would pass (its value never checked) and
  // removing `claude` could pass via the .claude fallback. Pin the set both ways.
  const registryIds = Object.keys(registry.runtimes).sort();
  const goldenIds = Object.keys(GOLDEN_DIR_MAP).sort();
  assert.deepEqual(registryIds, goldenIds,
    'registry.runtimes id set must exactly match GOLDEN_DIR_MAP — update the golden map when adding/removing a runtime');
});

test('getDirName fallback: unknown runtime returns ".claude"', () => {
  assert.strictEqual(getDirName('unknown'), '.claude',
    'getDirName("unknown") must return ".claude" (default fallback)');
});

test('getDirName fallback: empty string returns ".claude"', () => {
  assert.strictEqual(getDirName(''), '.claude',
    'getDirName("") must return ".claude" (empty-input fallback)');
});

test('registry cross-check: every runtimes[id].runtime.localConfigDir is a non-empty dot-dir string', () => {
  for (const [id, entry] of Object.entries(registry.runtimes)) {
    if (!entry || typeof entry !== 'object') continue;
    const runtimeBlock = entry.runtime;
    if (!runtimeBlock || typeof runtimeBlock !== 'object') continue;
    const dir = runtimeBlock.localConfigDir;
    assert.strictEqual(typeof dir, 'string',
      `registry.runtimes['${id}'].runtime.localConfigDir must be a string (got: ${typeof dir})`);
    assert.ok(dir.length > 0,
      `registry.runtimes['${id}'].runtime.localConfigDir must be non-empty`);
    assert.ok(dir.startsWith('.'),
      `registry.runtimes['${id}'].runtime.localConfigDir must start with '.' (got: ${JSON.stringify(dir)})`);
  }
});
