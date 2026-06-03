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
    // The gate must have an explicit false/skip branch
    assert.ok(
      workflow.includes("INTEL_CFG") &&
      (workflow.includes("'false'") || workflow.includes('"false"') || workflow.includes('false')),
      'workflow must skip the intel step when intel.enabled is false (config defaults to false)'
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
