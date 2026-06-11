'use strict';

/**
 * loop-hook-firing-spike.test.cjs — Spike #1018: structural "off means off" proof.
 *
 * Proves that the host-computed aggregate derived from activeHooks is a pure
 * function of the active hook set: when a capability is off, its step(s) are
 * absent from activeHooks, and the host aggregate is byte-identical to what a
 * zero-hooks base produces — by construction, not by authoring discipline.
 *
 * Uses the REAL capability-registry (not a synthetic fixture) for the UI-on/off
 * cases, then validates structural scaling with a synthetic multi-hook registry.
 *
 * Pure-function tests only — no I/O, no temp dirs, no cwd.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveLoopHooks,
  renderLoopHooks,
  CANONICAL_POINTS,
} = require('../gsd-core/bin/lib/loop-resolver.cjs');

// Real registry (UI capability at plan:pre, configSchema['workflow.ui_phase'].default = true)
const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

// ─── hostConsume helper ───────────────────────────────────────────────────────
//
// Models host consumption of the resolved+rendered envelope:
//   activeCount    — number of step-kind hooks (the host's execution list length)
//   skillsToInvoke — ordered skill refs from step hooks (the host's dispatch list)
//   rendered       — the markdown string the host would embed in its prompt
//
// This is the aggregate that must be IDENTICAL to the zero-hooks base when
// the capability is off (structural "off means off" — no host-source mutation).

function hostConsume(envelope) {
  const steps = envelope.activeHooks.filter(h => h.kind === 'step');
  return {
    activeCount: steps.length,
    skillsToInvoke: steps.map(h => h.ref && h.ref.skill).filter(Boolean),
    rendered: envelope.rendered,
  };
}

// ─── Compute the zero-hooks base for comparison ───────────────────────────────
//
// The base is what hostConsume produces when activeHooks is empty.
// We derive it from a fresh call with an empty registry so it is computed, not
// hand-coded — if renderLoopHooks ever changes its empty-string format, the
// base updates automatically and the "off = base" assertion still holds.

function makeBaseEnvelope(point) {
  const emptyByLoopPoint = {};
  for (const p of CANONICAL_POINTS) {
    emptyByLoopPoint[p] = { steps: [], contributions: [], gates: [] };
  }
  const emptyRegistry = { byLoopPoint: emptyByLoopPoint, configSchema: {} };
  const resolved = resolveLoopHooks({ point, registry: emptyRegistry, config: {} });
  return {
    activeHooks: resolved.activeHooks,
    rendered: renderLoopHooks(resolved),
  };
}

// ─── Synthetic multi-hook registry builder ───────────────────────────────────

function makeSyntheticRegistry(point, steps) {
  const byLoopPoint = {};
  for (const p of CANONICAL_POINTS) {
    byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
  }
  byLoopPoint[point].steps = steps;
  return { byLoopPoint, configSchema: {} };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('spike #1018 — off means off (structural proof)', () => {

  // ── Case 1: UI active by default ──────────────────────────────────────────
  //
  // config {} → workflow.ui_phase falls to configSchema default true → step active.
  // hostConsume must report activeCount=1, skillsToInvoke=['ui-phase'], and
  // rendered must include the ui-phase block.
  // The hook's onError must be carried through to activeHooks.

  test('UI active by default: config {} → activeCount=1, skillsToInvoke=[ui-phase], rendered includes ui-phase block', () => {
    const resolved = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: {},
    });
    const envelope = { activeHooks: resolved.activeHooks, rendered: renderLoopHooks(resolved) };
    const consumed = hostConsume(envelope);

    assert.strictEqual(consumed.activeCount, 1,
      'Expected exactly 1 active step when ui_phase defaults to true');
    assert.deepEqual(consumed.skillsToInvoke, ['ui-phase'],
      'skillsToInvoke must be [ui-phase]');
    assert.match(consumed.rendered, /### Step 1: skill:ui-phase \(ui\)/,
      'rendered must include the properly-structured Step block heading for ui-phase');

    // onError='skip' must be carried into the active hook entry
    const uiStep = resolved.activeHooks.find(h => h.kind === 'step' && h.ref && h.ref.skill === 'ui-phase');
    assert.ok(uiStep, 'ui-phase step must be present in activeHooks');
    assert.strictEqual(uiStep.onError, 'skip',
      "onError must be 'skip' as declared in the registry");
  });

  // ── Case 2: STEP-only-off (ui_phase=false, ui_safety_gate=true) ──────────────
  //
  // (#1026) plan:pre now has TWO hooks — a step (when: workflow.ui_phase) and a
  // gate (when: workflow.ui_safety_gate). They are INDEPENDENT toggles by design.
  // Turning off ui_phase suppresses the step but the gate (ui_safety_gate=true)
  // still fires → rendered is NOT the zero-hooks base (it contains the gate block).
  //
  // This case proves the step surface is a pure function of step-kind hooks:
  //   activeCount=0, skillsToInvoke=[] — "step off means step off".
  // It also asserts the gate IS present in activeHooks and rendered differs from
  // the empty base, documenting that the two toggles are genuinely independent.

  test('STEP-only-off: config {workflow:{ui_phase:false, ui_safety_gate:true}} → step absent, gate present, rendered ≠ base', () => {
    const stepOffConfig = { workflow: { ui_phase: false, ui_safety_gate: true } };
    const resolved = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: stepOffConfig,
    });
    const envelope = { activeHooks: resolved.activeHooks, rendered: renderLoopHooks(resolved) };
    const consumed = hostConsume(envelope);

    // Step-level aggregate: step is off
    assert.strictEqual(consumed.activeCount, 0,
      'Expected 0 active steps when ui_phase=false');
    assert.deepEqual(consumed.skillsToInvoke, [],
      'skillsToInvoke must be [] when ui_phase=false');

    // Gate is still active: activeHooks is NOT empty (contains the gate hook)
    const gateHooks = resolved.activeHooks.filter(h => h.kind === 'gate');
    assert.ok(gateHooks.length > 0,
      'Gate hook must still be present in activeHooks when ui_safety_gate=true');

    // Rendered is NOT the zero-hooks base because the gate block is present
    const base = makeBaseEnvelope('plan:pre');
    assert.notStrictEqual(consumed.rendered, base.rendered,
      'rendered must NOT equal the zero-hooks base when the gate is still active (ui_safety_gate=true)');

    // Rendered must NOT include a step block for ui-phase
    assert.ok(
      !consumed.rendered.includes('### Step') || !consumed.rendered.includes('ui-phase'),
      'OFF rendered must not include an active step block for ui-phase',
    );
  });

  // ── Case 2b: ALL-OFF (ui_phase=false, ui_safety_gate=false) ─────────────────
  //
  // Both toggles off → activeHooks is genuinely empty → rendered is byte-identical
  // to the zero-hooks base produced by the empty-registry helper.
  //
  // THIS is the clean structural "off means off → base output" proof.
  // It must exist as a concrete, computable assertion — not be elided because a
  // partial-off case happens to have a gate. The empty base is computed, not
  // hand-coded, so if renderLoopHooks ever changes its empty format this still holds.

  test('ALL-OFF: config {workflow:{ui_phase:false, ui_safety_gate:false}} → activeHooks empty AND rendered === base', () => {
    const allOffConfig = { workflow: { ui_phase: false, ui_safety_gate: false } };
    const resolved = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: allOffConfig,
    });
    const envelope = { activeHooks: resolved.activeHooks, rendered: renderLoopHooks(resolved) };

    // STRUCTURAL ASSERTION (the spike's core proof — restored):
    // When every hook at this point is toggled off, activeHooks must be empty
    // and rendered must be byte-identical to the computed zero-hooks base.
    // This proves the host aggregate is a pure function of activeHooks — no
    // capability leaks through when all its controlling config keys are false.
    assert.strictEqual(resolved.activeHooks.length, 0,
      'ALL-OFF: activeHooks must be empty when both ui_phase and ui_safety_gate are false');

    const base = makeBaseEnvelope('plan:pre');
    assert.strictEqual(envelope.rendered, base.rendered,
      'ALL-OFF: rendered must be byte-identical to the zero-hooks base when activeHooks is empty');
  });

  // ── Case 3: Synthetic multi-hook ──────────────────────────────────────────
  //
  // Registry with TWO step hooks at the same point, both unconditional (no `when`).
  // activeCount=2, skillsToInvoke preserves registry order.
  // Proves the aggregate scales and ordering survives.

  test('synthetic multi-hook: two steps at plan:pre → activeCount=2, skillsToInvoke preserves order', () => {
    const registry = makeSyntheticRegistry('plan:pre', [
      { capId: 'cap-alpha', ref: { skill: 'skill-alpha' }, kind: 'step' },
      { capId: 'cap-beta',  ref: { skill: 'skill-beta' },  kind: 'step' },
    ]);
    const resolved = resolveLoopHooks({
      point: 'plan:pre',
      registry,
      config: {},
    });
    const envelope = { activeHooks: resolved.activeHooks, rendered: renderLoopHooks(resolved) };
    const consumed = hostConsume(envelope);

    assert.strictEqual(consumed.activeCount, 2,
      'Expected 2 active steps for the two-hook synthetic registry');
    assert.deepEqual(consumed.skillsToInvoke, ['skill-alpha', 'skill-beta'],
      'skillsToInvoke must preserve registry order: [skill-alpha, skill-beta]');
  });

  // ── Case 4: verify:post ui-review active-by-default + onError:skip ───────────
  //
  // Proves the mechanism works at a SECOND loop point (verify:post), not just plan:pre.
  // config {} → workflow.ui_review falls to configSchema default true → ui-review step active.
  // The hook must carry onError:'skip', confirming the property is preserved across
  // both UI hook registrations, not just the plan:pre one already tested in Case 1.

  test('verify:post ui-review active by default: config {} → ui-review step present with onError=skip', () => {
    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry: realRegistry,
      config: {},
    });
    const uiReviewStep = resolved.activeHooks.find(
      h => h.kind === 'step' && h.ref && h.ref.skill === 'ui-review'
    );
    assert.ok(uiReviewStep,
      'ui-review step must be present in activeHooks at verify:post when config is {} (default true)');
    assert.strictEqual(uiReviewStep.onError, 'skip',
      "onError must be 'skip' on the ui-review step at verify:post");
    // Also verify the rendered output contains the structured heading for this point
    const rendered = renderLoopHooks(resolved);
    assert.match(rendered, /### Step 1: skill:ui-review \(ui\)/,
      'rendered must include the properly-structured Step block heading for ui-review at verify:post');
  });

  // ── Extra: zero-to-one transition ─────────────────────────────────────────
  //
  // Directly asserts the flip: same point, same registry, config toggles on/off.
  // activeCount goes 0 ↔ 1. Drives home that the resolver is a pure function.

  test('activeCount flips 0 ↔ 1 as config toggles ui_phase false/true', () => {
    const offResolved = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: { workflow: { ui_phase: false } },
    });
    const onResolved = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: { workflow: { ui_phase: true } },
    });

    const offConsumed = hostConsume({ activeHooks: offResolved.activeHooks, rendered: renderLoopHooks(offResolved) });
    const onConsumed  = hostConsume({ activeHooks: onResolved.activeHooks,  rendered: renderLoopHooks(onResolved) });

    assert.strictEqual(offConsumed.activeCount, 0, 'OFF: activeCount must be 0');
    assert.strictEqual(onConsumed.activeCount,  1, 'ON: activeCount must be 1');
    assert.notStrictEqual(onConsumed.rendered, offConsumed.rendered,
      'ON and OFF rendered outputs must differ');
  });
});
