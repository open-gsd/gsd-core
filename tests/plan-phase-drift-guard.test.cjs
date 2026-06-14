/**
 * Drift guard for gsd:plan-phase workflow (#22)
 *
 * Validates that the plan-phase workflow contains the key structural elements
 * added for issue #22 Change #1:
 *
 * (A) intel.enabled gate — when intel.enabled is true, plan-phase regenerates
 *     API-SURFACE.md via `gsd-tools intel api-surface` and injects it into the
 *     planner's required reading as a HINT (prefer symbols, may be incomplete,
 *     absence = unknown, never exhaustive).
 *
 * (B) "Artifacts this phase produces" section — every PLAN.md must include
 *     this section so the plan-review-convergence source-grounding pass can
 *     exclude newly-created symbols from drift verification.
 */

// allow-test-rule: source-text-is-the-product
// The workflow markdown IS the runtime instruction. Testing its text content
// tests the deployed contract — if the intel gate or Artifacts section
// requirement is absent, the drift-guard feature is absent from defenses too.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'plan-phase.md'
);

// ─── Fixture ──────────────────────────────────────────────────────────────────

const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

// ─── (A) intel.enabled gate ───────────────────────────────────────────────────

describe('plan-phase workflow: intel.enabled gate for API-SURFACE injection (#22)', () => {
  test('workflow reads intel.enabled config before planner spawn', () => {
    assert.ok(
      workflow.includes('intel.enabled'),
      'workflow must gate API-SURFACE generation on intel.enabled config key'
    );
  });

  test('workflow runs gsd-tools intel api-surface to regenerate surface', () => {
    assert.ok(
      workflow.includes('intel api-surface'),
      'workflow must call `gsd_run intel api-surface` (or equivalent) to regenerate API-SURFACE.md'
    );
  });

  test('workflow injects API-SURFACE.md into planner files_to_read when intel.enabled', () => {
    assert.ok(
      workflow.includes('API-SURFACE.md') && workflow.includes('API_SURFACE_PATH'),
      'workflow must pass API_SURFACE_PATH into the planner prompt files_to_read block'
    );
  });

  test('workflow labels the surface as a HINT (not a hard rule)', () => {
    assert.ok(
      workflow.includes('HINT') || workflow.includes('intel_surface_hint'),
      'API-SURFACE.md must be annotated as a HINT, never a hard rule'
    );
  });

  test('workflow documents that surface absence means unknown not nonexistent', () => {
    assert.ok(
      workflow.includes("absence means *unknown*, not *nonexistent*") ||
      workflow.includes("absence = unknown") ||
      workflow.includes("absence means unknown"),
      "workflow must state that a symbol's absence from the surface means unknown, not nonexistent"
    );
  });

  test('workflow states the surface may be incomplete', () => {
    assert.ok(
      workflow.includes('MAY BE INCOMPLETE') || workflow.includes('may be incomplete'),
      'workflow must warn that the API surface may be incomplete'
    );
  });

  test('workflow skips surface injection when intel.enabled is false', () => {
    assert.ok(
      workflow.includes('no active intel step hook exists') &&
      workflow.includes('API_SURFACE_PATH') &&
      (workflow.includes('when: intel.enabled') || workflow.includes('"when": "intel.enabled"')),
      'workflow must skip the intel step when intel.enabled is false — enforced via capability registry when: gate and explicit no-active-hook skip branch'
    );
  });
});

// ─── (B) "Artifacts this phase produces" requirement ─────────────────────────

describe('plan-phase workflow: Artifacts this phase produces section (#22)', () => {
  test('downstream_consumer block requires Artifacts this phase produces section', () => {
    assert.ok(
      workflow.includes('Artifacts this phase produces'),
      'downstream_consumer must list "Artifacts this phase produces" as a required plan section'
    );
  });

  test('quality_gate checklist includes Artifacts this phase produces item', () => {
    // Find the quality_gate block and confirm the checklist item is there
    const qualityGateMatch = workflow.match(/<quality_gate>([\s\S]*?)<\/quality_gate>/);
    assert.ok(
      qualityGateMatch,
      'workflow must have a <quality_gate> block'
    );
    assert.ok(
      qualityGateMatch[1].includes('Artifacts this phase produces'),
      '<quality_gate> checklist must include an "Artifacts this phase produces" item'
    );
  });

  test('workflow explains why Artifacts section is needed (source-grounding reviewer)', () => {
    assert.ok(
      workflow.includes('source-grounding') || workflow.includes('plan-review-convergence'),
      'workflow must explain that the Artifacts section is consumed by the source-grounding pass'
    );
  });

  test('workflow lists symbol kinds for Artifacts section (decorators, classes, functions, CLI flags)', () => {
    // Must enumerate concrete symbol kinds so planner knows what to list
    const hasDecorators = workflow.includes('decorators');
    const hasClasses = workflow.includes('classes');
    const hasFunctions = workflow.includes('functions');
    const hasCliFlags = workflow.includes('CLI flags');
    assert.ok(
      hasDecorators && hasClasses && hasFunctions && hasCliFlags,
      'workflow must enumerate symbol kinds: decorators, classes, functions, CLI flags (needed for Artifacts section guidance)'
    );
  });
});

// ─── (C) Top-level spawn guard (#913) ────────────────────────────────────────

describe('plan-phase workflow: top-level spawn guard (#913)', () => {
  // Extract the runtime_compatibility block for targeted assertions
  const rtBlock = (() => {
    const m = workflow.match(/<runtime_compatibility>([\s\S]*?)<\/runtime_compatibility>/);
    return m ? m[1] : '';
  })();

  test('workflow has a runtime_compatibility block asserting Agent is available at top-level', () => {
    assert.ok(
      rtBlock.length > 0,
      'plan-phase must have a <runtime_compatibility> block — prevents role-collapse regression (#913)'
    );
    assert.ok(
      rtBlock.includes('Agent tool IS available') || rtBlock.includes('Agent IS available'),
      'plan-phase runtime_compatibility must assert that the Agent tool IS available at top-level Claude Code (#913)'
    );
    assert.ok(
      rtBlock.toLowerCase().includes('top-level'),
      'plan-phase runtime_compatibility must scope the IS-available assertion to top-level Claude Code (#913)'
    );
    assert.ok(
      rtBlock.includes('Always spawn') || rtBlock.includes('always spawn'),
      'plan-phase runtime_compatibility must state that plan roles must always be spawned (#913)'
    );
    assert.ok(
      rtBlock.includes('Never absorb') || rtBlock.includes('never absorb'),
      'plan-phase runtime_compatibility must state that roles must never be absorbed inline (#913)'
    );
  });

  test('workflow states --chain/--auto suppress prompts only, not spawns', () => {
    assert.ok(
      rtBlock.includes('suppress') &&
      (rtBlock.includes('prompts only') || rtBlock.includes('interactive prompts only')),
      'plan-phase runtime_compatibility must document that --chain/--auto suppress prompts only, not spawns (#913)'
    );
  });

  test('workflow does not contain unscoped CODEX RUNTIME orchestrator rule labels', () => {
    // All "wait for subagent" rules must apply to ALL RUNTIMES, not just Codex
    assert.ok(
      !workflow.includes('ORCHESTRATOR RULE — CODEX RUNTIME'),
      'plan-phase must not label orchestrator wait rules as "CODEX RUNTIME" — they apply to all runtimes including top-level Claude Code (#913)'
    );
  });

  test('workflow contains ALL RUNTIMES orchestrator rule labels (count preserved)', () => {
    // Must have all 7 agent-spawn wait rules still present (none dropped during rename)
    const allRuntimesCount = (workflow.match(/ORCHESTRATOR RULE — ALL RUNTIMES/g) || []).length;
    assert.ok(
      allRuntimesCount >= 7,
      `plan-phase must have at least 7 "ORCHESTRATOR RULE — ALL RUNTIMES" labels (one per agent spawn site); found ${allRuntimesCount} (#913)`
    );
  });
});

// ─── (D) Attempt-based Agent gate (#922) ─────────────────────────────────────

describe('plan-phase workflow: attempt-based Agent availability gate (#922)', () => {
  // Extract the runtime_compatibility block for targeted assertions
  const rtBlock = (() => {
    const m = workflow.match(/<runtime_compatibility>([\s\S]*?)<\/runtime_compatibility>/);
    return m ? m[1] : '';
  })();

  // Extract the "Other runtimes" clause specifically
  const otherRuntimesClause = (() => {
    const m = rtBlock.match(/\*\*Other runtimes[^*]*\*\*[^\n]*\n([\s\S]*?)(?=\n\*\*|$)/);
    return m ? m[0] : rtBlock;
  })();

  test('Other runtimes clause does not authorize stopping on a self-assessed absence (#922)', () => {
    // The pre-#922 wording ("if the Agent tool is genuinely absent") let the model
    // self-assess and stop without ever attempting a call. The fixed wording must
    // not contain phrasing that authorizes that pattern.
    const forbiddenPatterns = [
      /if the Agent tool is genuinely absent/i,
      /if.*Agent.*genuinely absent/i,
    ];
    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !pattern.test(otherRuntimesClause),
        `plan-phase "Other runtimes" clause must not authorize stopping on a self-assessed Agent absence — ` +
        `use attempt-based gate instead (#922). Found: ${otherRuntimesClause.trim()}`
      );
    }
  });

  test('Other runtimes clause pins "Always attempt the actual Agent() call" language (#922)', () => {
    // Pin the exact contract phrase so a future edit that changes to "try to determine
    // availability" or "check if Agent is available" does not silently reintroduce introspection.
    assert.ok(
      otherRuntimesClause.includes('Always attempt the actual') ||
      otherRuntimesClause.includes('always attempt the actual'),
      `plan-phase "Other runtimes" clause must pin "Always attempt the actual Agent() call" (or equivalent) (#922). ` +
      `Found: ${otherRuntimesClause.trim()}`
    );
  });

  test('Other runtimes clause pins "real tool-unavailable error" as the only valid stop signal (#922)', () => {
    // Must tie the stop to a real returned error, not a self-assessed absence.
    assert.ok(
      otherRuntimesClause.includes('real tool-unavailable error') ||
      otherRuntimesClause.includes('tool-unavailable error returned'),
      `plan-phase "Other runtimes" clause must state only a real tool-unavailable error from Agent() authorizes stopping (#922). ` +
      `Found: ${otherRuntimesClause.trim()}`
    );
  });

  test('Other runtimes clause still prohibits inline role collapse (#922 preserves #913)', () => {
    // Even after the attempt-based rewrite the clause must keep the no-inline-collapse guard.
    const hasNoInline =
      otherRuntimesClause.toLowerCase().includes('do not') &&
      (otherRuntimesClause.toLowerCase().includes('inline') ||
       otherRuntimesClause.toLowerCase().includes('collapse'));
    assert.ok(
      hasNoInline,
      `plan-phase "Other runtimes" clause must still prohibit inline role collapse even with the attempt-based gate (#922). ` +
      `Found: ${otherRuntimesClause.trim()}`
    );
  });
});
