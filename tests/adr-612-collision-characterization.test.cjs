'use strict';

/**
 * Characterization test for the M-NN phase-ID collision — the PR-0 anchor
 * requested in the #612 (bracket phase-ID convention) approval.
 *
 * See docs/adr/612-bracket-phase-id-convention.md, Decision 3.
 *
 * This test captures the CURRENT behavior of `normalizePhaseName`
 * (src/phase-id.cts:66 → gsd-core/bin/lib/phase-id.cjs). It is NOT a bug the
 * PR fixes — PR-0 is zero behavior change. It "proves the defect first":
 * a fully-specified milestone/phase/subphase/plan token silently collapses to
 * a bare two-digit integer under the milestone-prefixed (M-NN) grammar, because
 * the hyphen is overloaded (milestone↔phase in one position, phase↔plan in
 * another) and the anchored milestone regex cannot consume a trailing plan
 * hyphen that follows a subphase dot.
 *
 * Mechanism (both regexes are in normalizePhaseName):
 *   - Anchored milestone regex (src/phase-id.cts:71):
 *       /^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i
 *     On "2-01.02-01" it captures 2, then "-01", then ".02"; the trailing "-01"
 *     (the plan) is not expressible as (?:\.\d+)* so the `$` anchor fails and
 *     the match is rejected.
 *   - Unanchored numeric fallback (src/phase-id.cts:79):
 *       /^(\d+)([A-Z])?((?:\.\d+)*)/i
 *     With no `$`, it matches only the leading "2" and zero-pads to "02";
 *     everything after the leading integer is silently dropped.
 *
 * These assertions are the byte-identical current-behavior contract. They are
 * expected to be REPLACED — not merely to keep passing — when PR-1 lands the
 * bracket grammar (parsePhaseId/renderPhaseId/toDir) behind
 * `phase_id_convention: 'bracket'`, at which point a full bracket token
 * (`GSD.02-05.03-01`) parses to exactly one tuple and the collapse no longer
 * occurs on the bracket path. Until then, this file documents the ambiguity.
 *
 * All assertions are BEHAVIORAL (call the exported function, assert its typed
 * output). No source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
const { normalizePhaseName } = phaseId;
const fc = require('fast-check');

describe('ADR-612 PR-0 — M-NN phase-ID collision (current-behavior characterization)', () => {
  test('the full 4-tuple token "2-01.02-01" collapses to bare "02" (the anchor defect)', () => {
    // Intended meaning: milestone 2, phase 01, subphase 02, plan 01.
    // The anchored milestone regex rejects the trailing plan hyphen after ".02",
    // so control falls to the unanchored fallback, which keeps only the leading
    // "2" and zero-pads it. A fully-specified identity collapses to bare "02".
    assert.equal(normalizePhaseName('2-01.02-01'), '02');

    // It did NOT round-trip the input: there is no single deterministic 4-tuple
    // a parser can return under M-NN without out-of-band convention metadata.
    assert.notEqual(normalizePhaseName('2-01.02-01'), '02-01.02-01');
  });

  test('the collapse is a general class, not a single case: "10-02.03-04" collapses to "10"', () => {
    // Same failure mode: the trailing "-04" (plan) after ".03" (subphase) kills
    // the anchored milestone match; the fallback keeps only "10".
    assert.equal(normalizePhaseName('10-02.03-04'), '10');
  });

  test('the collapse appears ONLY when all four dimensions coexist (defect boundary)', () => {
    // milestone + phase — anchored milestone regex matches, no collapse.
    assert.equal(normalizePhaseName('2-01'), '02-01');
    // + subphase (dot tail) — anchored regex still matches, no collapse.
    assert.equal(normalizePhaseName('2-01.02'), '02-01.02');
    // + plan (a hyphen after the subphase dot) — anchor fails, token collapses.
    assert.equal(normalizePhaseName('2-01.02-01'), '02');
  });

  test('"02-04" is a cross-subsystem semantic ambiguity, not a parse collapse', () => {
    // normalizePhaseName reads "02-04" as milestone 02 / phase 04 and returns it
    // intact — this token does NOT collapse.
    assert.equal(normalizePhaseName('02-04'), '02-04');
    // The SAME string is the phase-02 / plan-04 token in plan-file notation
    // ({padded_phase}-{NN}-PLAN.md). Both readings are valid productions; the
    // token alone cannot tell a resolver which subsystem is asking. This is a
    // genuine ambiguity but a different class than the collapse above.
  });
});

/**
 * Property generalization of the collapse (requested by the PR-2181 review:
 * "covers the collapse with literal examples only; no fast-check property test
 * generalizing the collision class"). The literal cases above assert two points
 * on the class; this proves the collapse is the CLASS behavior, not cherry-
 * picked examples: for EVERY fully-specified 4-dimension M-NN token
 * `${m}-${pp}.${ss}-${ll}` (m: 1-99 integer, no leading zeros; pp, ss, ll:
 * zero-padded 2-digit 01-99), normalizePhaseName collapses it to the bare
 * zero-padded milestone `String(m).padStart(2, '0')`.
 *
 * Still GREEN-ONLY: it characterizes CURRENT behavior exactly (same contract as
 * the literal cases). It is expected to be REPLACED, not merely kept passing,
 * when PR-1 lands the bracket grammar (parsePhaseId/renderPhaseId/toDir) behind
 * `phase_id_convention: 'bracket'`, at which point a full bracket token parses
 * to exactly one tuple and the collapse no longer occurs on the bracket path.
 *
 * numRuns: the house default for the fast-check block in tests/phase-id.test.cjs
 * is the implicit 100; this sets 1000 for denser sampling of the ~96M-combination
 * class (99^4). The property was additionally verified EXHAUSTIVELY offline over
 * all 96,059,601 tokens of the domain (0 failures) — it holds totally, not just
 * on the sampled draws, so no domain narrowing was needed.
 */
describe('ADR-612 PR-0 — M-NN collapse is the class, not the examples (fast-check property)', () => {
  const pad2 = (n) => String(n).padStart(2, '0');

  test('every 4-tuple `${m}-${pp}.${ss}-${ll}` collapses to bare `String(m).padStart(2,"0")`', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }), // milestone m — leading integer, no leading zeros
        fc.integer({ min: 1, max: 99 }), // phase pp     — rendered zero-padded 2-digit
        fc.integer({ min: 1, max: 99 }), // subphase ss  — rendered zero-padded 2-digit
        fc.integer({ min: 1, max: 99 }), // plan ll      — rendered zero-padded 2-digit
        (m, pp, ss, ll) => {
          // The trailing plan hyphen after the subphase dot kills the anchored
          // milestone regex (src/phase-id.cts:71); the unanchored fallback
          // (src/phase-id.cts:79) keeps only the leading integer, zero-padded.
          const token = `${m}-${pad2(pp)}.${pad2(ss)}-${pad2(ll)}`;
          return normalizePhaseName(token) === String(m).padStart(2, '0');
        },
      ),
      { numRuns: 1000 },
    );
  });
});
