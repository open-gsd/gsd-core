'use strict';
/**
 * Drift-guard + collapse: getRuntimeLabel must be the SINGLE source of truth for
 * the install/uninstall console display label, replacing the two duplicated
 * `runtimeLabel` assignment chains that previously lived in bin/install.js
 * (uninstall() and install()) — the add-a-host tax ADR-1239 Phase B (#1679)
 * eliminates.
 *
 * Verifies:
 *   1. For every known runtime id, getRuntimeLabel(id) equals the hardcoded
 *      golden expected map — a pinned oracle that catches BOTH table bugs AND
 *      unintended drift (adding/removing a runtime forces a deliberate
 *      golden-map update here).
 *   2. getRuntimeLabel('unknown') and getRuntimeLabel('') fall back to
 *      'Claude Code' (the always-safe default).
 *   3. The golden id set EXACTLY equals the capability-registry runtime id set
 *      (adding/removing a runtime forces a golden update here).
 *
 * Voice: these are the SHORT UI labels used in the install/uninstall console
 * output, intentionally distinct from the descriptor `title` (the long product
 * name, e.g. "OpenAI Codex CLI", "GitHub Copilot") which serves
 * documentation/registry display. Two prior-chain inconsistencies are resolved
 * by this canonical map (both move toward the majority + descriptor value):
 *   - kimi: install said 'Kimi', uninstall said 'Kimi CLI' → canonical 'Kimi CLI'
 *   - cline: install said 'Cline', uninstall omitted it (→ 'Claude Code') → canonical 'Cline'
 *
 * ADR-1239 Phase B (#1679).
 * Behavioral tests only: assert on returned values, no source-grep.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { getRuntimeLabel } = runtimeNamePolicy;

// Golden oracle: hardcoded expected map of all 16 runtime ids to their short
// install/uninstall display label. A pinned expected value in a TEST is correct
// — the test IS the oracle (non-circular). Only PRODUCTION code should derive
// dynamically. If this map diverges from getRuntimeLabel output, either the
// table is wrong OR the registry changed — both require a deliberate golden-map
// update here.
const GOLDEN_LABEL_MAP = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  kilo: 'Kilo',
  codex: 'Codex',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  augment: 'Augment',
  trae: 'Trae',
  qwen: 'Qwen Code',
  hermes: 'Hermes Agent',
  kimi: 'Kimi CLI',
  codebuddy: 'CodeBuddy',
  cline: 'Cline',
};

test('getRuntimeLabel: golden map matches for all 16 known runtime ids', () => {
  for (const [id, expected] of Object.entries(GOLDEN_LABEL_MAP)) {
    const actual = getRuntimeLabel(id);
    assert.strictEqual(
      actual,
      expected,
      `getRuntimeLabel('${id}') diverged from golden.\n` +
      `  actual:   ${JSON.stringify(actual)}\n` +
      `  expected: ${JSON.stringify(expected)}`,
    );
  }
});

test('drift guard: registry runtime id set EXACTLY equals the golden map (adding/removing a runtime forces a golden update)', () => {
  // Without this, a newly-added runtime would pass (its label never checked) and
  // removing `claude` could pass via the 'Claude Code' fallback. Pin the set
  // both ways — mirroring the getDirName drift guard.
  const registryIds = Object.keys(registry.runtimes).sort();
  const goldenIds = Object.keys(GOLDEN_LABEL_MAP).sort();
  assert.deepEqual(registryIds, goldenIds,
    'registry.runtimes id set must exactly match GOLDEN_LABEL_MAP — update the golden map when adding/removing a runtime');
});

test('getRuntimeLabel fallback: unknown runtime returns "Claude Code"', () => {
  assert.strictEqual(getRuntimeLabel('unknown'), 'Claude Code',
    'getRuntimeLabel("unknown") must return "Claude Code" (default fallback)');
});

test('getRuntimeLabel fallback: empty string returns "Claude Code"', () => {
  assert.strictEqual(getRuntimeLabel(''), 'Claude Code',
    'getRuntimeLabel("") must return "Claude Code" (empty-input fallback)');
});

test('getRuntimeLabel fallback: alias is NOT auto-expanded (raw id match only)', () => {
  // getRuntimeLabel is a raw-id lookup, not alias-aware (unlike canonicalizeRuntimeName).
  // Callers pass an already-canonicalized runtime id. An alias must fall back to
  // the default rather than silently matching — this keeps the label surface
  // explicit and prevents a future alias from changing console output by accident.
  assert.strictEqual(getRuntimeLabel('claude-code'), 'Claude Code',
    'getRuntimeLabel("claude-code") must return the default "Claude Code" (raw-id match only; aliases are not expanded)');
});
