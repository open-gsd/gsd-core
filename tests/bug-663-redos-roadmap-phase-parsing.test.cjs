/**
 * Regression test for the ReDoS fixes in buildRoadmapPhaseVariants() and
 * buildNotStartedPhaseVariants() (src/validate.cts, fix #663).
 *
 * The old patterns used nested quantifiers that caused catastrophic
 * backtracking on crafted input:
 *   old: [\w][\w.-]*(?:-[\w.-]+)*  ← ambiguous alternation → exponential
 *   new: [\w][\w.-]*               ← single quantifier → linear
 *
 * The same nested-quantifier shape was fixed identically in src/verify.cts,
 * src/commands.cts, and src/phase.cts.
 *
 * Part A: behavior preservation — the collapsed regex still matches the same
 *   phase identifiers as before on normal roadmap content.
 * Part B: ReDoS guard — pathological input that caused catastrophic
 *   backtracking under the old pattern completes in well under 1 second with
 *   the fixed pattern.
 *
 * Requirements: TEST-663-B
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const {
  buildRoadmapPhaseVariants,
  buildNotStartedPhaseVariants,
} = require('../gsd-core/bin/lib/validate.cjs');

// ─── Part A: behavior preservation ───────────────────────────────────────────

describe('buildRoadmapPhaseVariants — behavior preservation (#663)', () => {
  test('matches plain numeric heading (Phase 1:)', () => {
    const content = [
      '# Roadmap',
      '## Phase 1: Foo',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('1'), 'roadmapPhases should contain "1"');
  });

  test('matches milestone-prefixed heading (Phase 2-01:)', () => {
    const content = [
      '# Roadmap',
      '### Phase 2-01: Bar',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('2-01'), 'roadmapPhases should contain "2-01"');
  });

  test('matches bracket-prefixed heading ([GSD] Phase 3.2:)', () => {
    const content = [
      '# Roadmap',
      '### [GSD] Phase 3.2: Baz',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('3.2'), 'roadmapPhases should contain "3.2"');
  });

  test('collects all phase identifiers from mixed-format roadmap', () => {
    const content = [
      '# Roadmap',
      '## Phase 1: Alpha',
      '### Phase 2-01: Beta',
      '### [GSD] Phase 3.2: Gamma',
    ].join('\n');

    const { roadmapPhases } = buildRoadmapPhaseVariants(content);
    assert.ok(roadmapPhases.has('1'), 'should have phase 1');
    assert.ok(roadmapPhases.has('2-01'), 'should have phase 2-01');
    assert.ok(roadmapPhases.has('3.2'), 'should have phase 3.2');
  });

  test('populates roadmapPhaseVariants with padding-normalized forms', () => {
    const content = [
      '# Roadmap',
      '### Phase 2-01: Beta',
    ].join('\n');

    const { roadmapPhaseVariants } = buildRoadmapPhaseVariants(content);
    // phaseVariants() adds both padded and unpadded forms
    assert.ok(roadmapPhaseVariants.has('2-01') || roadmapPhaseVariants.has('02-01'),
      'roadmapPhaseVariants should contain at least one padding form of 2-01');
  });
});

describe('buildNotStartedPhaseVariants — behavior preservation (#663)', () => {
  test('matches unchecked checklist item (- [ ] Phase 4-01:)', () => {
    const content = [
      '# Roadmap',
      '- [ ] Phase 4-01: Qux',
    ].join('\n');

    const notStarted = buildNotStartedPhaseVariants(content);
    // phaseVariants() expands 4-01 into multiple forms; at minimum the raw form is present.
    assert.ok(notStarted.has('4-01') || notStarted.has('04-01'),
      'notStarted should contain a variant of 4-01');
  });

  test('does not pick up checked items', () => {
    const content = [
      '# Roadmap',
      '- [x] Phase 5: Done',
    ].join('\n');

    const notStarted = buildNotStartedPhaseVariants(content);
    assert.strictEqual(notStarted.has('5'), false, 'completed phase should not be in notStarted');
  });
});

// ─── Part B: ReDoS guard ──────────────────────────────────────────────────────

describe('buildRoadmapPhaseVariants — ReDoS guard (#663)', () => {
  // Pathological input: a heading line where the phase-id segment consists of
  // many consecutive "-a" chunks with NO terminating colon.  Under the old
  // nested-quantifier pattern ([\w.-]*(?:-[\w.-]+)*\s*:) the engine must
  // explore exponentially many ways to partition the "-a" repetitions across
  // the two quantifiers before concluding there is no match.  The fixed
  // single-quantifier pattern ([\w.-]*\s*:) backtracks linearly.
  test('completes in < 1000 ms on pathological input (no terminating colon)', { timeout: 5000 }, () => {
    const pathological = '## Phase a' + '-a'.repeat(32) + ' ';
    const t0 = performance.now();
    buildRoadmapPhaseVariants(pathological);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 1000, `ReDoS: buildRoadmapPhaseVariants took ${elapsed.toFixed(1)} ms (expected < 1000 ms)`);
  });
});

describe('buildNotStartedPhaseVariants — ReDoS guard (#663)', () => {
  // Same analysis: the old uncheckedPattern used the same nested quantifier.
  // A checklist-style line with many "-a" segments and no colon/space triggers
  // the same catastrophic backtracking.
  test('completes in < 1000 ms on pathological unchecked-item input', { timeout: 5000 }, () => {
    const pathological = '- [ ] Phase a' + '-a'.repeat(32) + ' ';
    const t0 = performance.now();
    buildNotStartedPhaseVariants(pathological);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 1000, `ReDoS: buildNotStartedPhaseVariants took ${elapsed.toFixed(1)} ms (expected < 1000 ms)`);
  });
});
