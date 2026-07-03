'use strict';

/**
 * Property-based tests for normalizePhaseReqIds range expansion (#1269).
 *
 * Module: gsd-core/bin/lib/gap-checker.cjs
 * Exported: normalizePhaseReqIds(rawVal)
 *
 * Range form (#1269): a `--phase-req-ids` list element of the shape
 * `<PREFIX>-NN..<PREFIX>-MM` (identical prefix both sides, identical bound digit
 * width, ascending numeric NN ≤ MM) expands in place to the individual IDs,
 * preserving the bounds' zero-pad width; ambiguous/invalid ranges stay literal
 * (fail-closed).
 *
 * Properties tested:
 *   (a) valid ascending same-prefix, same-width range → length == MM-NN+1, all
 *       elements share the prefix, suffixes are strictly monotonic NN..MM,
 *       width preserved
 *   (b) NN == MM → single-element expansion equal to the (re-padded) bound
 *   (c) literal preservation: a non-range token round-trips unchanged
 *   (d) fail-closed: descending and mismatched-prefix ranges stay literal
 *   (d3) fail-closed: differing-width bounds stay literal
 *   (d4) fail-closed: non-numeric bounds stay literal
 *   (d5) fail-closed: missing left/right bound stays literal
 *   (d6) fail-closed: multi-dot tokens stay literal
 *   (e) never throws on arbitrary string input
 *
 * Lives in a sibling *.property.test.cjs file (the established property-test
 * convention). Its effective prefix `gap-checker.property` does not match the
 * `gap-checker` production prefix, so it does not count against the per-module
 * test-file cap; the unit/integration fixtures are folded into
 * bug-447-gap-analysis-phase-req-ids.test.cjs instead.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { normalizePhaseReqIds } = require('../gsd-core/bin/lib/gap-checker.cjs');

// A safe prefix that always ends in '-', contains no whitespace, commas,
// brackets, quotes, parens, or dots (those are stripped/split by the
// normalizer), and never collides with the null/TBD/none sentinels.
const prefixArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9]{0,5}$/)
  .filter(s => !/^(null|tbd|none)$/i.test(s))
  .map(s => `${s}-`);

const widthArb = fc.integer({ min: 1, max: 4 });

function pad(n, width) {
  return String(n).padStart(width, '0');
}

describe('#1269 normalizePhaseReqIds — range expansion properties', () => {
  test('(a) valid ascending same-prefix, same-width range expands to MM-NN+1 monotonic same-prefix IDs', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (prefix, a, b, w) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // Both bounds share width w; choose w wide enough to hold hi so neither
        // bound is truncated and both render at the SAME digit width.
        const width = Math.max(w, String(hi).length);
        const loStr = pad(lo, width);
        const hiStr = pad(hi, width);
        const token = `${prefix}${loStr}..${prefix}${hiStr}`;

        const result = normalizePhaseReqIds(token);

        // length == MM - NN + 1
        assert.strictEqual(result.length, hi - lo + 1, `length for ${token}`);
        // all elements share the prefix
        for (const id of result) {
          assert.ok(id.startsWith(prefix), `${id} must start with ${prefix}`);
        }
        // suffixes are strictly monotonic NN..MM, each padded to the shared width
        result.forEach((id, i) => {
          const expectedNum = lo + i;
          assert.strictEqual(id, `${prefix}${pad(expectedNum, width)}`,
            `element ${i} of ${token}`);
        });
      },
    ));
  });

  test('(d3) differing-width bounds stay literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      widthArb,
      (prefix, a, b, wA, wB) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const loStr = pad(lo, wA);
        const hiStr = pad(hi, wB);
        // Only exercise the differing-width case here.
        fc.pre(loStr.length !== hiStr.length);
        const token = `${prefix}${loStr}..${prefix}${hiStr}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d4) non-numeric bounds stay literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      // A suffix containing at least one non-digit so the bound is non-numeric.
      fc.stringMatching(/^[0-9]*[A-Za-z][0-9A-Za-z]*$/),
      fc.stringMatching(/^[0-9]*[A-Za-z][0-9A-Za-z]*$/),
      (prefix, sLo, sHi) => {
        const token = `${prefix}${sLo}..${prefix}${sHi}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d5) missing left or right bound stays literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 99 }),
      widthArb,
      fc.boolean(),
      (prefix, n, w, dropLeft) => {
        const bound = `${prefix}${pad(n, w)}`;
        const token = dropLeft ? `..${bound}` : `${bound}..`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d6) multi-dot tokens stay literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (prefix, a, b, c, w) => {
        const token = `${prefix}${pad(a, w)}..${prefix}${pad(b, w)}..${prefix}${pad(c, w)}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(b) NN == MM expands to a single re-padded bound', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 99 }),
      widthArb,
      (prefix, n, w) => {
        const nStr = pad(n, w);
        const token = `${prefix}${nStr}..${prefix}${nStr}`;
        const result = normalizePhaseReqIds(token);
        // Expected width is nStr.length, not w: when n has more digits than w
        // (e.g. n=99, w=1), pad() returns the un-truncated "99", so the emitted
        // ID preserves the bound's actual width — which is what the range parser does.
        assert.deepStrictEqual(result, [`${prefix}${pad(n, nStr.length)}`]);
      },
    ));
  });

  test('(c) a non-range single token round-trips unchanged (literal preservation)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 0, max: 999 }),
      widthArb,
      (prefix, n, w) => {
        const id = `${prefix}${pad(n, w)}`; // a plain ID, no '..'
        assert.deepStrictEqual(normalizePhaseReqIds(id), [id]);
      },
    ));
  });

  test('(d) descending range stays literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 50 }),
      widthArb,
      (prefix, a, b, w) => {
        fc.pre(a !== b);
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        // Deliberately put the larger bound first → descending → must stay literal.
        const token = `${prefix}${pad(hi, w)}..${prefix}${pad(lo, w)}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(d2) mismatched-prefix range stays literal (fail-closed)', () => {
    fc.assert(fc.property(
      prefixArb,
      prefixArb,
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 0, max: 50 }),
      widthArb,
      (p1, p2, a, b, w) => {
        fc.pre(p1 !== p2);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const token = `${p1}${pad(lo, w)}..${p2}${pad(hi, w)}`;
        assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
      },
    ));
  });

  test('(e) never throws on arbitrary string input', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      // Either a valid normalized value or null — but never an exception.
      assert.doesNotThrow(() => normalizePhaseReqIds(s));
    }));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-447-gap-analysis-phase-req-ids.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-447-gap-analysis-phase-req-ids (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Bug #447: plan-phase §13e gap-analysis ignores phase_req_ids → false-positive
 * coverage gaps.
 *
 * Root cause: runGapAnalysis() diffs the ENTIRE REQUIREMENTS.md against the
 * phase's plans, with no awareness of phase_req_ids. §13 (Requirements Coverage
 * Gate) skips when phase_req_ids is null/TBD, but §13e never inherited that
 * scoping contract — so a phase that maps no requirements reports every
 * unrelated project REQ-ID as "Not covered".
 *
 * Fix: teach the gap-analysis CLI a --phase-req-ids option (the durable home for
 * the scoping contract), mirroring §13:
 *   - null / TBD / empty  → skip the REQUIREMENTS.md comparison entirely
 *                           (CONTEXT.md decisions are still reported).
 *   - explicit ID list    → restrict the comparison to those IDs.
 *   - flag absent         → backward-compatible (compare the whole file).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { normalizePhaseReqIds } = require('../gsd-core/bin/lib/gap-checker.cjs');

describe('gap-analysis --phase-req-ids scoping (#447)', () => {
  let tmpDir;
  let phaseDir;

  function writeRequirements(ids) {
    const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n${lines.join('\n')}\n`);
  }

  function writeContext(decisions) {
    const dLines = decisions.map(d => `- **${d.id}:** ${d.text}`).join('\n');
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'),
      `# Phase Context\n\n<decisions>\n## Implementation Decisions\n\n${dLines}\n</decisions>\n`);
  }

  function writePlan(name, body) {
    fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
  }

  function reqRows(out) {
    return out.rows.filter(r => r.source === 'REQUIREMENTS.md').map(r => r.item);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(r.success, `config-ensure-section failed: ${r.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  // ── The core bug ─────────────────────────────────────────────────────────────

  test('phase mapping no REQs (--phase-req-ids TBD) reports zero REQUIREMENTS.md rows', () => {
    // A REQUIREMENTS.md full of IDs that belong to OTHER phases/milestones.
    writeRequirements(['BACK-01', 'WEB-03', 'API-07', 'DATA-02']);
    writePlan('01', '# Plan 1\n\nStandalone phase, maps no project requirements.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'TBD'], tmpDir);
    assert.ok(r.success, `gap-analysis failed: ${r.error}`);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out), [],
      'a phase that maps no REQ-IDs must not report unrelated project requirements as gaps');
    assert.strictEqual(out.counts.uncovered, 0,
      'no false-positive "not covered" rows for an unmapped phase');
  });

  test('--phase-req-ids null behaves the same as TBD (skip requirements)', () => {
    writeRequirements(['BACK-01', 'WEB-03']);
    writePlan('01', '# Plan\n\nNo mapped reqs.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'null'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), []);
  });

  // ── Scoped to a mapped subset ────────────────────────────────────────────────

  test('explicit ID list restricts the comparison to those REQ-IDs', () => {
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    // Plan covers REQ-01 only; REQ-02 is mapped to the phase but not yet addressed.
    writePlan('01', '# Plan\n\nImplements REQ-01 only.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01,REQ-02'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'only the phase-mapped REQ-IDs are considered; REQ-03 (another phase) is excluded');
    const req01 = out.rows.find(x => x.item === 'REQ-01');
    const req02 = out.rows.find(x => x.item === 'REQ-02');
    assert.strictEqual(req01.status, 'Covered');
    assert.strictEqual(req02.status, 'Not covered');
  });

  test('JSON-array-ish value (["REQ-01"]) is tolerated and scoped', () => {
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', '["REQ-01"]'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), ['REQ-01']);
  });

  // ── CONTEXT.md decisions are unaffected by req scoping ───────────────────────

  test('CONTEXT.md decisions are still reported when requirements are skipped', () => {
    writeRequirements(['BACK-01', 'WEB-03']);
    writeContext([{ id: 'D-01', text: 'Use a local notification daemon' }]);
    writePlan('01', '# Plan\n\nUnrelated work, no decisions addressed.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'TBD'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out), [], 'requirements skipped');
    const d01 = out.rows.find(x => x.item === 'D-01');
    assert.ok(d01, 'CONTEXT.md decision D-01 must still be reported');
    assert.strictEqual(d01.source, 'CONTEXT.md');
    assert.strictEqual(d01.status, 'Not covered');
  });

  // ── Parser robustness (workflow passes the roadmap value verbatim) ───────────

  test('whitespace/newline-separated IDs are tolerated and scoped', () => {
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan('01', '# Plan\n\nImplements the first one.\n');
    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01 REQ-02\nREQ-03'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02', 'REQ-03']);
  });

  // ── Backward compatibility ───────────────────────────────────────────────────

  test('flag absent → whole REQUIREMENTS.md is compared (unchanged behavior)', () => {
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nImplements REQ-01 only.\n');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'with no --phase-req-ids, all requirements are still reported (back-compat)');
  });

  // ── §13e wiring: init.plan-phase --pick phase_req_ids → gap-analysis ─────────
  // Guards the exact query the workflow uses. `roadmap.get-phase` returns raw
  // phase TEXT (not JSON), so --pick yields nothing there; the scoping value
  // must come from `init.plan-phase`. This test would have caught using the
  // wrong query (which silently skips requirements for every phase).

  function writeRoadmap(reqLine) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 1: Test Phase\n**Goal:** Do the thing\n${reqLine}**Success Criteria:**\n- It works\n`);
  }

  test('init.plan-phase --pick phase_req_ids exposes the mapped IDs, and gap-analysis scopes to them', () => {
    writeRoadmap('**Requirements:** REQ-01, REQ-02\n');
    writeRequirements(['REQ-01', 'REQ-02', 'REQ-03']);
    writePlan('01', '# Plan\n\nImplements the first requirement only.\n');

    const q = runGsdTools(['query', 'init.plan-phase', '1', '--pick', 'phase_req_ids'], tmpDir);
    assert.ok(q.success, `init.plan-phase query failed: ${q.error}`);
    const ids = q.output.trim();
    assert.match(ids, /REQ-01/, 'init.plan-phase must expose phase_req_ids (roadmap.get-phase does NOT)');

    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-02'],
      'gap report is scoped to the phase-mapped IDs; REQ-03 (another phase) is excluded');
  });

  test('mapped REQ-ID absent from REQUIREMENTS.md appears as "Missing" row, not silently dropped', () => {
    writeRequirements(['REQ-01']);
    writePlan('01', '# Plan\n\nImplements REQ-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'REQ-01,REQ-99'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['REQ-01', 'REQ-99'],
      'REQ-99 (absent from REQUIREMENTS.md) must be present in the report, not silently dropped');
    const req99 = out.rows.find(x => x.item === 'REQ-99');
    assert.ok(req99, 'missing mapped ID must have an output row');
    assert.strictEqual(req99.status, 'Missing from REQUIREMENTS.md');
    assert.ok(out.counts.uncovered > 0, 'uncovered count must reflect the missing mapped ID');
  });

  test('phase with no Requirements line → init.plan-phase yields empty → gap-analysis skips requirements', () => {
    writeRoadmap(''); // no **Requirements:** line
    writeRequirements(['REQ-01', 'REQ-02']);
    writePlan('01', '# Plan\n\nStandalone phase.\n');

    const q = runGsdTools(['query', 'init.plan-phase', '1', '--pick', 'phase_req_ids'], tmpDir);
    assert.ok(q.success, q.error);
    const ids = q.output.trim(); // expected empty

    // The workflow passes the (possibly empty) value through verbatim.
    const r = runGsdTools(['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', ids], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.deepStrictEqual(reqRows(out), [],
      'an unmapped phase reports no requirement gaps (the original #447 bug)');
  });
});

/**
 * #1269: `--phase-req-ids` range syntax (`<PREFIX>-NN..<PREFIX>-MM`) was treated
 * as a literal ID, so a mapped range was reported as a coverage gap even when the
 * individual IDs existed. normalizePhaseReqIds now expands a valid ascending
 * same-prefix numeric range in place (preserving zero-pad width), and leaves any
 * ambiguous/invalid range literal (fail-closed). These unit fixtures are folded
 * here (the owning home for --phase-req-ids behavior) rather than a new
 * bug-NNNN-* file, per the regression-test-placement policy.
 */
describe('#1269 — normalizePhaseReqIds range expansion', () => {
  // ── The core bug: a range token must expand, not stay literal ────────────────

  test('AC1: range + single ID expands in input order (was the literal-token bug)', () => {
    // Pre-fix this returned ['SEL-01..SEL-03','TEST-01'] — the unexpanded range.
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-01..SEL-03,TEST-01'),
      ['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01'],
      'a same-prefix ascending range must expand in place, preserving list order');
  });

  test('AC2: zero-pad width is preserved across the expansion', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('PREFIX-001..PREFIX-003'),
      ['PREFIX-001', 'PREFIX-002', 'PREFIX-003']);
  });

  // ── AC3: existing behavior is unchanged ──────────────────────────────────────

  test('AC3: single-ID, comma/space/newline, and JSON-array-ish inputs unchanged', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01'), ['REQ-01']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01,REQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01 REQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds('REQ-01\nREQ-02'), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(normalizePhaseReqIds(['REQ-01', 'REQ-02']), ['REQ-01', 'REQ-02']);
    assert.strictEqual(normalizePhaseReqIds(undefined), undefined);
    assert.strictEqual(normalizePhaseReqIds(null), null);
    assert.strictEqual(normalizePhaseReqIds('TBD'), null);
    assert.strictEqual(normalizePhaseReqIds(''), null);
  });

  // ── AC4: invalid/ambiguous ranges stay LITERAL (fail-closed) ─────────────────

  test('AC4: mismatched-prefix range stays literal (no partial expansion)', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-01..TEST-03'), ['SEL-01..TEST-03']);
  });

  test('AC4: descending range stays literal', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-03..SEL-01'), ['SEL-03..SEL-01']);
  });

  test('AC4: non-numeric bound stays literal', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-0A..SEL-0C'), ['SEL-0A..SEL-0C']);
  });

  test('AC4: missing bound stays literal', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-01..'), ['SEL-01..']);
    assert.deepStrictEqual(normalizePhaseReqIds('..SEL-03'), ['..SEL-03']);
  });

  test('AC4: an invalid range inside a mixed list stays literal while valid ones expand', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-01..SEL-03,BAD-3..BAD-1'),
      ['SEL-01', 'SEL-02', 'SEL-03', 'BAD-3..BAD-1']);
  });

  // ── Boundary fixtures ────────────────────────────────────────────────────────

  test('boundary: single-element range (NN == MM)', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-02..SEL-02'), ['SEL-02']);
  });

  test('boundary: two-element range (NN == MM-1)', () => {
    assert.deepStrictEqual(normalizePhaseReqIds('SEL-01..SEL-02'), ['SEL-01', 'SEL-02']);
  });

  test('boundary: differing zero-pad widths stay literal (fail-closed)', () => {
    // Bounds of differing digit width are ambiguous: padding 'SEL-9' to width 2
    // would invent 'SEL-09', which may never appear unpadded in REQUIREMENTS.
    // Fail closed — leave the whole token literal rather than guess.
    assert.deepStrictEqual(
      normalizePhaseReqIds('SEL-9..SEL-11'),
      ['SEL-9..SEL-11']);
  });

  test('AC4: a range exceeding MAX_PHASE_REQ_RANGE stays literal (DoS guard)', () => {
    // Same-width bounds (both 4 digits) so the differing-width guard does NOT fire
    // first; span = 1001 - 1 + 1 = 1001 > MAX_PHASE_REQ_RANGE (1000) → the DoS cap
    // is what keeps this literal. Isolates the cap branch from the width check.
    const token = 'REQ-0001..REQ-1001';
    assert.deepStrictEqual(normalizePhaseReqIds(token), [token]);
  });

  test('multi-segment prefix with digits is handled (prefix compared verbatim)', () => {
    assert.deepStrictEqual(
      normalizePhaseReqIds('REQ2-01..REQ2-03'),
      ['REQ2-01', 'REQ2-02', 'REQ2-03']);
  });
});

/**
 * #1269 integration (AC5): the gap-analysis CLI must not flag a mapped range —
 * or the IDs it expands to — as missing when those IDs exist in REQUIREMENTS.md.
 */
describe('#1269 — gap-analysis --phase-req-ids range (integration)', () => {
  let tmpDir;
  let phaseDir;

  function writeRequirements(ids) {
    const lines = ids.map((id, i) => `- [ ] **${id}** Requirement ${i + 1} description`);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n${lines.join('\n')}\n`);
  }
  function writePlan(name, body) {
    fs.writeFileSync(path.join(phaseDir, `${name}-PLAN.md`), body);
  }
  function reqRows(out) {
    return out.rows.filter(r => r.source === 'REQUIREMENTS.md').map(r => r.item);
  }

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    const r = runGsdTools('config-ensure-section', tmpDir);
    assert.ok(r.success, `config-ensure-section failed: ${r.error}`);
  });

  afterEach(() => cleanup(tmpDir));

  test('AC5: a mapped range is expanded and not flagged as missing when the IDs exist', () => {
    writeRequirements(['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01', 'OTHER-09']);
    // The plan addresses each expanded SEL id and TEST-01.
    writePlan('01', '# Plan\n\nImplements SEL-01, SEL-02, SEL-03, and TEST-01.\n');

    const r = runGsdTools(
      ['gap-analysis', '--phase-dir', phaseDir, '--phase-req-ids', 'SEL-01..SEL-03,TEST-01'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);

    assert.deepStrictEqual(reqRows(out).sort(), ['SEL-01', 'SEL-02', 'SEL-03', 'TEST-01'],
      'the range expands to individual SEL IDs; the literal range token must NOT appear, and OTHER-09 (unmapped) is excluded');
    // The literal range token must never surface as a missing row.
    assert.ok(!out.rows.some(x => x.item.includes('..')),
      'no range-literal row (e.g. "SEL-01..SEL-03") may be reported');
    assert.strictEqual(out.counts.uncovered, 0,
      'all expanded IDs exist in REQUIREMENTS.md and are covered — zero gaps');
  });
});
  });
}
