'use strict';
/**
 * getRuntimeLabel is the SINGLE source of truth for the short install/uninstall
 * console display label, replacing the two duplicated `runtimeLabel` assignment
 * chains that previously lived in bin/install.js (uninstall() and install()) —
 * the add-a-host tax ADR-1239 Phase B (#1679) eliminates.
 *
 * Because 1.7.0 (ADR-1016 / ADR-1239) makes runtimes pluggable data, the label
 * table is CURATED (a runtime id → short label mapping that cannot be derived
 * from the id alone, e.g. "Claude Code", "Qwen Code", "ZCode"). This test
 * enforces the COVERAGE CONTRACT rather than a frozen per-runtime snapshot:
 *
 *   - every runtime in the capability registry MUST resolve to a distinct,
 *     non-default curated label (a newly-added runtime that forgets to add a
 *     label entry silently falls through to "Claude Code" and fails here);
 *   - the fail-closed fallback returns "Claude Code" for unknown / empty / alias
 *     inputs (raw-id match only — aliases are NOT auto-expanded).
 *
 * Adding a runtime descriptor requires adding its label to RUNTIME_LABELS (the
 * deliberate curation step); it does NOT require editing a count or golden
 * snapshot here.
 *
 * Voice: these SHORT UI labels are intentionally distinct from the descriptor
 * `title` (the long product name). Two prior-chain inconsistencies are resolved
 * by the canonical map: kimi → 'Kimi CLI'; cline → 'Cline'.
 *
 * ADR-1239 Phase B (#1679). Behavioral tests only: assert on returned values.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { getRuntimeLabel, getRuntimeNewProjectCommand } = runtimeNamePolicy;

const FALLBACK = 'Claude Code';
const RUNTIME_IDS = Object.keys(registry.runtimes);

test('getRuntimeLabel: every registry runtime resolves to a non-empty curated label (coverage contract, count-agnostic)', () => {
  assert.ok(RUNTIME_IDS.length > 0, 'registry must contain at least one runtime');
  for (const id of RUNTIME_IDS) {
    const label = getRuntimeLabel(id);
    assert.strictEqual(typeof label, 'string', `getRuntimeLabel('${id}') must be a string`);
    assert.ok(label.length > 0, `getRuntimeLabel('${id}') must be non-empty`);
  }
});

test('getRuntimeLabel drift guard: no registry runtime except claude falls through to the default (forces a deliberate label per runtime)', () => {
  // claude's curated label IS the fallback string, so it is exempt. Every other
  // registry runtime must resolve to a DISTINCT label — otherwise it was added
  // without a RUNTIME_LABELS entry and is silently masking as "Claude Code".
  for (const id of RUNTIME_IDS) {
    if (id === 'claude') continue;
    assert.notStrictEqual(
      getRuntimeLabel(id),
      FALLBACK,
      `registry runtime '${id}' resolved to the fallback "${FALLBACK}" — add a distinct entry to RUNTIME_LABELS in src/runtime-name-policy.cts`);
  }
});

test('getRuntimeLabel fallback: unknown / empty / alias inputs return "Claude Code" (fail-closed, raw-id match only)', () => {
  assert.strictEqual(getRuntimeLabel('unknown'), FALLBACK);
  assert.strictEqual(getRuntimeLabel(''), FALLBACK);
  assert.strictEqual(getRuntimeLabel('claude-code'), FALLBACK,
    'getRuntimeLabel("claude-code") must return the default (raw-id match only; aliases are not expanded)');
});

// ---------------------------------------------------------------------------
// getRuntimeNewProjectCommand (ADR-1239 Phase B / #1679 AC2) — the per-runtime
// /gsd-new-project invocation syntax for the post-install next-step message.
// ---------------------------------------------------------------------------

// CURATED override table — runtimes whose /gsd-new-project invocation differs
// from the default. All other registry runtimes resolve to the default.
const NEW_PROJECT_OVERRIDES = {
  codex: '$gsd-new-project',
  cursor: 'gsd-new-project (mention the skill name)',
  kimi: '/skill:gsd-new-project',
};
const DEFAULT_CMD = '/gsd-new-project';

test('getRuntimeNewProjectCommand: each override runtime resolves to its curated command', () => {
  for (const [id, expected] of Object.entries(NEW_PROJECT_OVERRIDES)) {
    assert.strictEqual(getRuntimeNewProjectCommand(id), expected, `override ${id}`);
  }
});

test('getRuntimeNewProjectCommand: every registry runtime not in the override table resolves to the default (count-agnostic)', () => {
  for (const id of RUNTIME_IDS) {
    if (Object.prototype.hasOwnProperty.call(NEW_PROJECT_OVERRIDES, id)) continue;
    assert.strictEqual(getRuntimeNewProjectCommand(id), DEFAULT_CMD,
      `runtime '${id}' must return the default command (add to NEW_PROJECT_OVERRIDES if it needs a non-default form)`);
  }
});

test('getRuntimeNewProjectCommand: unknown / empty → default (fail-closed)', () => {
  assert.strictEqual(getRuntimeNewProjectCommand('unknown'), DEFAULT_CMD);
  assert.strictEqual(getRuntimeNewProjectCommand(''), DEFAULT_CMD);
});
