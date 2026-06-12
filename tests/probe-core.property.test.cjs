'use strict';

/**
 * Property-based tests for probe-core.cjs (ADR-550 Decision 7).
 *
 * Module: gsd-core/bin/lib/probe-core.cjs (generated from src/probe-core.cts)
 * Exercised: analyzeCoverage(items, resolutions?, validators) — the generic
 * merge/rollup/orphan-reject engine shared by the edge probe and the #644
 * prohibition probe.
 *
 * trek-e re-review #7 N2 (RULESET.TESTS.property-based-testing): analyzeCoverage is a
 * transformation/rollup module (items × resolutions → CoverageReport) — exactly the
 * class the predicate covers. The example-based suite (tests/probe-core.test.cjs)
 * pins specific scenarios; these properties pin the algebraic invariants that must
 * hold for EVERY valid scenario.
 *
 * Properties tested:
 *   (a) closed-set identity: applicable === resolved + unresolved (and === items.length)
 *   (b) byVerification sums ≤ resolved (dismissed is closed but unverified)
 *   (c) per-tier byVerification ≤ resolved, and only `resolved`-status items are counted
 *   (d) determinism: same input → identical CoverageReport (stable rollup)
 *   (e) orphan rejection is stable: a resolution matching no proposed item always throws
 */

const { describe, test } = require('node:test');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const BUILT_SCRIPT = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');
const pc = require(BUILT_SCRIPT);

// The same representative validators bundle the edge adapter injects (see
// tests/probe-core.test.cjs) — exercises the generic engine independent of any one probe.
const VALIDATORS = {
  categories: ['adjacency', 'empty', 'ordering'],
  verification: ['explicit', 'backstop'],
  requiredFieldsByVerification: { explicit: ['resolution'], backstop: ['resolution'] },
};

function bareItem(requirement_id, category) {
  return {
    requirement_id,
    category,
    status: 'unresolved',
    verification: null,
    resolution: null,
    reason: null,
    probe: `probe-for-${category}`,
  };
}

const catArb = fc.constantFrom(...VALIDATORS.categories);
const idArb = fc.constantFrom('R1', 'R2', 'R3', 'R4', 'R5');
const keyArb = fc.record({ requirement_id: idArb, category: catArb });
// Unique (requirement_id, category) keys — the merge keys analyzeCoverage maps on.
const keyOf = (k) => `${k.requirement_id}::${k.category}`;
const uniqueKeysArb = fc.uniqueArray(keyArb, { selector: keyOf, minLength: 0, maxLength: 12 });

// Each unique item key gets one resolution disposition. Resolution text/reason use fixed
// non-empty literals — the counting invariants are independent of their content, and this
// keeps the generator off the validateResolution rejection paths (which the example suite
// already covers exhaustively).
const DISPOSITIONS = ['none', 'resolved-explicit', 'resolved-backstop', 'dismissed', 'unresolved'];

function resolutionFor(k, disposition) {
  const base = { requirement_id: k.requirement_id, category: k.category };
  switch (disposition) {
    case 'resolved-explicit':
      return { ...base, status: 'resolved', verification: 'explicit', resolution: 'AC#1' };
    case 'resolved-backstop':
      return { ...base, status: 'resolved', verification: 'backstop', resolution: 'held-out PBT suite' };
    case 'dismissed':
      return { ...base, status: 'dismissed', reason: 'bounded enum — not applicable' };
    case 'unresolved':
      return { ...base, status: 'unresolved' };
    default: // 'none' — author left no resolution; item rolls up verbatim (bare unresolved)
      return null;
  }
}

// A fully valid scenario: unique items (all bare-unresolved) + a per-item resolution choice.
const scenarioArb = uniqueKeysArb.chain((keys) =>
  fc.tuple(...keys.map(() => fc.constantFrom(...DISPOSITIONS))).map((choices) => {
    const items = keys.map((k) => bareItem(k.requirement_id, k.category));
    const resolutions = [];
    keys.forEach((k, i) => {
      const r = resolutionFor(k, choices[i]);
      if (r) resolutions.push(r);
    });
    return { items, resolutions };
  }),
);

describe('probe-core property: analyzeCoverage algebraic invariants', () => {
  test('(a) closed-set identity: applicable === resolved + unresolved === items.length', () => {
    fc.assert(
      fc.property(scenarioArb, ({ items, resolutions }) => {
        const { coverage } = pc.analyzeCoverage(items, resolutions, VALIDATORS);
        return (
          coverage.applicable === coverage.resolved + coverage.unresolved &&
          coverage.applicable === items.length
        );
      }),
    );
  });

  test('(b) sum(byVerification) ≤ resolved — dismissed counts closed but unverified', () => {
    fc.assert(
      fc.property(scenarioArb, ({ items, resolutions }) => {
        const { coverage } = pc.analyzeCoverage(items, resolutions, VALIDATORS);
        const verifiedTotal = Object.values(coverage.byVerification).reduce((a, b) => a + b, 0);
        return verifiedTotal <= coverage.resolved && verifiedTotal >= 0;
      }),
    );
  });

  test('(c) byVerification only counts resolved-status items, and matches a direct recount', () => {
    fc.assert(
      fc.property(scenarioArb, ({ items, resolutions }) => {
        const rep = pc.analyzeCoverage(items, resolutions, VALIDATORS);
        for (const tier of VALIDATORS.verification) {
          const recount = rep.items.filter((i) => i.status === 'resolved' && i.verification === tier).length;
          if (rep.coverage.byVerification[tier] !== recount) return false;
          if (rep.coverage.byVerification[tier] > rep.coverage.resolved) return false;
        }
        return true;
      }),
    );
  });

  test('(d) determinism: identical inputs produce an identical CoverageReport', () => {
    fc.assert(
      fc.property(scenarioArb, ({ items, resolutions }) => {
        const a = pc.analyzeCoverage(items, resolutions, VALIDATORS);
        const b = pc.analyzeCoverage(items, resolutions, VALIDATORS);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
    );
  });
});

describe('probe-core property: orphan rejection is stable', () => {
  // An orphan resolution carries an id ('Z9') that no generated item ever uses, so its
  // (requirement_id, category) key never matches a proposed item. The resolution is itself
  // structurally VALID (a bare unresolved), so it clears validateResolution and reaches the
  // orphan-reject guard — isolating that guard from input-validation throws.
  const orphanScenarioArb = fc.record({
    keys: uniqueKeysArb,
    orphanCategory: catArb,
  });

  test('(e) a resolution matching no proposed item always throws', () => {
    fc.assert(
      fc.property(orphanScenarioArb, ({ keys, orphanCategory }) => {
        const items = keys.map((k) => bareItem(k.requirement_id, k.category));
        const orphan = { requirement_id: 'Z9', category: orphanCategory, status: 'unresolved' };
        let threwForOrphan = false;
        try {
          pc.analyzeCoverage(items, [orphan], VALIDATORS);
        } catch (e) {
          threwForOrphan = /unknown resolution|no matching proposed item/i.test(e.message);
        }
        return threwForOrphan;
      }),
    );
  });
});
