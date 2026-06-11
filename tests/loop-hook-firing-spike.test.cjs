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

  // ── Case 2: UI off ─────────────────────────────────────────────────────────
  //
  // config { workflow: { ui_phase: false } } → step filtered out.
  // hostConsume must report activeCount=0, skillsToInvoke=[], and
  // rendered must equal the base/no-active form — the OFF output IS the base.

  test('UI off: config {workflow:{ui_phase:false}} → activeCount=0, skillsToInvoke=[], rendered equals zero-hooks base', () => {
    const offConfig = { workflow: { ui_phase: false } };
    const resolved = resolveLoopHooks({
      point: 'plan:pre',
      registry: realRegistry,
      config: offConfig,
    });
    const envelope = { activeHooks: resolved.activeHooks, rendered: renderLoopHooks(resolved) };
    const consumed = hostConsume(envelope);

    const base = makeBaseEnvelope('plan:pre');
    const baseConsumed = hostConsume(base);

    assert.strictEqual(consumed.activeCount, 0,
      'Expected 0 active steps when ui_phase=false');
    assert.deepEqual(consumed.skillsToInvoke, [],
      'skillsToInvoke must be [] when ui_phase=false');

    // STRUCTURAL ASSERTION (the spike's point):
    // The off-state host output is identical to the host's zero-hooks base.
    // The aggregate is a pure function of activeHooks — nothing in host source
    // was mutated. This proves "off means off" by construction.
    assert.strictEqual(consumed.rendered, baseConsumed.rendered,
      'OFF rendered output must be byte-identical to the zero-hooks base rendered output (pure function of activeHooks)');
    assert.strictEqual(consumed.activeCount, baseConsumed.activeCount,
      'OFF activeCount must equal base activeCount');
    assert.deepEqual(consumed.skillsToInvoke, baseConsumed.skillsToInvoke,
      'OFF skillsToInvoke must equal base skillsToInvoke');
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
