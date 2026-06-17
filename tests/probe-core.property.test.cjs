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
// #1278: the check-descriptor deterministic-locate round-trip crosses three modules — probe-core's
// projector, the shared flat parser, and the enforcement read-back adapter. Require all three here so
// the property exercises the real end-to-end chain (not a stubbed seam).
const fm = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'frontmatter.cjs'));
const enforce = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'prohibition-enforcement.cjs'));

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

// ─── #1278: the check-descriptor deterministic-locate round-trip (property-based) ────────────────
// trek-e re-review (RULESET.TESTS.property-based-testing): the projectProhibitions -> render ->
// parseMustHavesBlock -> descriptorFromProjection chain is a bijective/transformation contract. The
// example suite (tests/prohibition-probe.schema.test.cjs CHK-03 A/B/C) pins three hand-picked rows;
// these properties pin the invariant across the FULL input domain — including the parseMustHavesBlock
// numeric-coercion case (a /^\d+$/ scalar parses back as a number; descriptorFromProjection
// String()-normalizes it) and the under-specified fail-closed cases. The "stable" contract is
// expressed at the descriptorFromProjection reconstruction layer, because the raw parse step is
// intentionally lossy for numeric scalars (the shared parser coerces; #1278 does not change it).

// Mirror of the schema test's renderProhibitionsDoc: flat scalar continuation KVs, emitted only when
// present (src/frontmatter.cts:344 reads them back as scalar `key: value` lines).
function renderProhibitionsDoc(entries) {
  const lines = ['---', 'phase: 01-x', 'plan: 01', 'must_haves:', '  prohibitions:'];
  for (const e of entries) {
    lines.push(`    - statement: "${e.statement}"`);
    lines.push(`      status: ${e.status}`);
    if (e.verification !== undefined) lines.push(`      verification: ${e.verification}`);
    if (e.reason !== undefined) lines.push(`      reason: "${e.reason}"`);
    if (e.check_kind !== undefined) lines.push(`      check_kind: ${e.check_kind}`);
    if (e.check_target !== undefined) lines.push(`      check_target: ${e.check_target}`);
    if (e.check_rule !== undefined) lines.push(`      check_rule: ${e.check_rule}`);
    if (e.check_violation_fixture !== undefined) lines.push(`      check_violation_fixture: ${e.check_violation_fixture}`);
  }
  lines.push('---', '', 'Body.', '');
  return lines.join('\n');
}

const BASE_TIER = Object.freeze({
  requirement_id: 'R1', category: 'safety', status: 'resolved', verification: 'test',
  resolution: null, reason: null, statement: 'MUST NOT do the forbidden thing',
});
const KIND_ARB = fc.constantFrom('node-test', 'lint-rule');
// Path-like scalar that is NEVER pure-digit (so the flat parser does not numeric-coerce it) — models
// realistic targets / rule-ids. The renderer is unquoted, so the charset excludes whitespace, quotes
// and colons that the flat continuation-KV regex would not round-trip.
const PATH_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-'.split('');
const pathScalarArb = fc.array(fc.constantFrom(...PATH_CHARS), { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join(''))
  .filter((s) => /\D/.test(s)); // ≥1 non-digit → stays a string through parseMustHavesBlock
// Canonical integer string — exercises the numeric-coercion path (render `key: 12345` -> parse coerces
// to NUMBER -> descriptorFromProjection String()-normalizes back). Capped well under MAX_SAFE_INTEGER,
// no leading zeros, so the integer round-trips exactly.
const numericScalarArb = fc.nat({ max: 9999999 }).map(String);
const targetArb = fc.oneof(pathScalarArb, numericScalarArb);

// A fully well-formed descriptor item (resolved test-tier); node-test carries no rule. The
// violation fixture (#1346) rides BOTH kinds and exercises the numeric-coercion path too.
const wellFormedArb = KIND_ARB.chain((kind) =>
  fc.record({ target: targetArb, rule: pathScalarArb, fixture: targetArb }).map(({ target, rule, fixture }) => {
    const item = { ...BASE_TIER, check_kind: kind, check_target: target, check_violation_fixture: fixture };
    if (kind === 'lint-rule') item.check_rule = rule;
    return { item, kind, target, rule: kind === 'lint-rule' ? rule : undefined, fixture };
  }),
);

describe('probe-core property: #1278 check-descriptor round-trip is deterministic across the full string domain', () => {
  test('a well-formed descriptor survives project -> render -> parse -> descriptorFromProjection (incl. numeric coercion); target/rule reconstruct as strings', () => {
    fc.assert(
      fc.property(wellFormedArb, ({ item, kind, target, rule, fixture }) => {
        const projected = pc.projectProhibitions([item]);
        if (projected[0].check_kind !== kind) return false; // projector emits the descriptor
        const reparsed = fm.parseMustHavesBlock(renderProhibitionsDoc(projected), 'prohibitions');
        const d = enforce.descriptorFromProjection(reparsed[0]);
        if (!d || d.kind !== kind) return false;
        // target is string-normalized even when parseMustHavesBlock numerically coerced it.
        if (typeof d.target !== 'string' || d.target !== target) return false;
        // violationFixture (#1346) survives the round-trip as a string (numeric-coercion normalized).
        if (typeof d.violationFixture !== 'string' || d.violationFixture !== fixture) return false;
        if (kind === 'lint-rule') {
          return typeof d.rule === 'string' && d.rule === rule;
        }
        return !('rule' in d); // a node-test descriptor never carries a rule
      }),
    );
  });
});

// Under-specified / invalid projected descriptors: the deterministic-locate contract is fail-CLOSED —
// the adapter + the producer's existing locate guard must NEVER green and ALWAYS flag, even when the
// (injected) runner would report a pass.
const malformedArb = fc.oneof(
  fc.constant({ ...BASE_TIER }),                                               // absent descriptor (no check_*)
  KIND_ARB.map((kind) => ({ ...BASE_TIER, check_kind: kind })),               // valid kind, NO target
  pathScalarArb.map((t) => ({ ...BASE_TIER, check_kind: 'lint-rule', check_target: t })), // lint-rule, NO rule
  fc.record({ k: fc.constantFrom('shell-script', 'bash', 'python', 'exec', ''), t: targetArb })
    .map(({ k, t }) => ({ ...BASE_TIER, check_kind: k, check_target: t })),   // unknown kind
);

describe('probe-core property: #1278 under-specified descriptor is always fail-closed (never green)', () => {
  test('an absent / target-less / rule-less / unknown-kind descriptor never disposes green and is always flagged + unlocated', () => {
    fc.assert(
      fc.property(malformedArb, (projectedItem) => {
        const d = enforce.descriptorFromProjection(projectedItem);
        const result = enforce.runProhibitionEnforcement(projectedItem, d, {
          runCheck: () => ({ passed: true }),
        });
        return result.status !== 'green' && result.flagged === true && result.located === false;
      }),
    );
  });
});
