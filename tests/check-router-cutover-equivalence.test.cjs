'use strict';

/**
 * Cutover-equivalence characterization suite for the `check` router (#5139,
 * Phase 6 of #5056; ADR-5057 §4 first bullet, ADR-2346 style).
 *
 * Every payload arm of every gate that `routeCheckCommand` dispatches has a
 * fixture, the exact argv, and a golden: the stdout string, the stderr string
 * and the exit code that the PRE-MOVE code produced, captured by executing it
 * (never hand-written). The suite rebuilds the same fixtures, runs the real
 * `gsd-tools.cjs query check.<verb>` subprocess and compares stdout
 * byte-for-byte as strings, so the gate move must not change one character.
 *
 * Fixtures and the arm catalogue live in tests/fixtures/gate-cutover/arms.cjs
 * (shared with the capture script). The only run-dependent text, the temp
 * root, is rewritten to `<TMP>` by one shared normaliser in both capture and
 * comparison.
 *
 * Rows: E1..E11 (one describe per gate), auto-mode, R1 (router export
 * surface), R2 (phase-dir / ROADMAP lookup behaviour table), R4
 * (readModifiedFilesContent caps at limit-1 / limit / limit+1), P1 (property
 * over decisionMentioned).
 *
 * Read-failure arms (E11: unreadable COVERAGE.md, unreadable plan) are driven
 * through the real CLI with a `--require` preload that makes fs.readFileSync
 * throw EACCES for one path suffix: deterministic, and not defeated by root.
 *
 * Not reachable through the CLI: the api-coverage "resolved phase dir escapes
 * .planning/" arm (findPhaseInternal only ever returns directories under
 * .planning/phases or .planning/milestones; a phase directory symlinked outside
 * .planning is not resolved at all, and a GSD_WORKSTREAM does not change that),
 * so it has no golden; it is driven through the gate's injected resolver in
 * tests/gate-api-coverage-verify-pre-escape.test.cjs.
 *
 * `tdd-red-evidence-path-escape` is the one golden NOT captured from the pre-move
 * code: the record path used to be read uncontained, and a path escaping the
 * project directory is now the usage failure every sibling gate raises.
 *
 * The four other E6 payload goldens (`tdd-red-evidence-ok`, `-invalid-exit-zero`,
 * `-invalid-zero-tests`, `-empty-object`) were re-captured from the format-adapter
 * classifier (#4692): `evidence` gains `matched_test`, `format` and
 * `report_errors`, and `record.failing_test` names only the matched target.
 * Verdicts, reasons, stderr and exit codes are unchanged.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const {
  arms,
  buildFixture,
  runArm,
} = require('./fixtures/gate-cutover/arms.cjs');
const router = require('../gsd-core/bin/lib/check-command-router.cjs');

const GOLDEN_DIR = path.join(__dirname, 'fixtures', 'gate-cutover');

// One temp project per fixture, reused by every arm that names it.
const fixtureRoots = new Map();
function rootFor(name) {
  if (!fixtureRoots.has(name)) fixtureRoots.set(name, buildFixture(name));
  return fixtureRoots.get(name);
}

after(() => {
  for (const root of fixtureRoots.values()) cleanup(root);
  fixtureRoots.clear();
});

function readGolden(id) {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${id}.json`), 'utf8'));
}

function armsFor(group) {
  return arms.filter((a) => a.gate === group);
}

function assertArmMatchesGolden(spec) {
  const golden = readGolden(spec.id);
  assert.deepStrictEqual(golden.argv, spec.argv, 'golden argv is the arm argv');
  assert.strictEqual(golden.fixture, spec.fixture, 'golden fixture is the arm fixture');
  const actual = runArm(spec, rootFor(spec.fixture));
  assert.strictEqual(actual.outcome, 'exited', 'the gate subprocess exited on its own');
  assert.strictEqual(actual.stdout, golden.stdout, `${spec.id}: stdout differs byte-for-byte`);
  assert.strictEqual(actual.stderr, golden.stderr, `${spec.id}: stderr differs`);
  assert.strictEqual(actual.exitCode, golden.exitCode, `${spec.id}: exit code differs`);
}

function describeGroup(title, group) {
  describe(title, () => {
    for (const spec of armsFor(group)) {
      test(spec.id, () => assertArmMatchesGolden(spec));
    }
  });
}

// ─── catalogue integrity ──────────────────────────────────────────────────────

describe('golden catalogue', () => {
  test('every arm has exactly one golden and every golden has an arm', () => {
    const ids = arms.map((a) => a.id).sort();
    assert.strictEqual(new Set(ids).size, ids.length, 'arm ids are unique');
    const onDisk = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    assert.deepStrictEqual(onDisk, ids);
  });

  test('every golden stores stdout as a string and has no temp path in it', () => {
    for (const spec of arms) {
      const golden = readGolden(spec.id);
      assert.strictEqual(typeof golden.stdout, 'string', `${spec.id}: stdout is a string`);
      assert.strictEqual(typeof golden.exitCode, 'number', `${spec.id}: exit code is a number`);
      assert.ok(!/gsd-cutover-/.test(golden.stdout + golden.stderr), `${spec.id}: temp root normalised to <TMP>`);
    }
  });
});

// ─── E1..E11 + auto-mode + dispatcher ─────────────────────────────────────────

describeGroup('E1 decision-coverage-plan', 'E1');
describeGroup('E2 decision-coverage-verify', 'E2');
describeGroup('E3 ui-plan-gate', 'E3');
describeGroup('E4 ui-safety-gate', 'E4');
describeGroup('E5 tdd-review-checkpoint', 'E5');
describeGroup('E6 tdd-red-evidence', 'E6');
describeGroup('E7 verify-command-paths', 'E7');
describeGroup('E8 verify-failure-directions', 'E8');
describeGroup('E9 gap-analysis-plan-post', 'E9');
describeGroup('E10 predicate', 'E10');
describeGroup('E11 api-coverage-verify-pre', 'E11');
describeGroup('auto-mode', 'auto');
describeGroup('dispatcher', 'dispatch');

// ─── R1: the router export surface ────────────────────────────────────────────

describe('R1 router export surface', () => {
  const EXPECTED = [
    'routeCheckCommand',
    'decisionMentioned',
    'extractPlanDesignatedSections',
    'computeUiPlanGate',
    'computeUiSafetyGate',
    'cmdGapAnalysisPlanPost',
    'cmdVerifyCommandPaths',
    'cmdVerifyFailureDirections',
    'cmdTddReviewCheckpoint',
    'cmdTddRedEvidence',
    'cmdCheckPredicate',
    'buildPredicateDeps',
    'parsePredicateFlags',
    'partitionPredicateArgs',
    'readPhaseScope',
  ];

  test('there are exactly 15 exports and every one is a function', () => {
    assert.strictEqual(EXPECTED.length, 15);
    for (const name of EXPECTED) {
      assert.strictEqual(typeof router[name], 'function', `${name} is a function`);
    }
    assert.deepStrictEqual(Object.keys(router).sort(), [...EXPECTED].sort());
  });
});

// ─── R2: phase lookup behaviour table ─────────────────────────────────────────

describeGroup('R2 phase-dir and ROADMAP lookup goldens', 'R2');

describe('R2 behaviour table', () => {
  const parsed = (id) => JSON.parse(readGolden(id).stdout);

  test('numeric and zero-padded phase resolve to the same phase in every gate', () => {
    const planNumeric = parsed('r2-ui-plan-gate-numeric');
    assert.deepStrictEqual(parsed('r2-ui-plan-gate-zero-padded'), planNumeric);
    assert.strictEqual(planNumeric.block, true);

    const safetyNumeric = parsed('r2-ui-safety-gate-numeric');
    const safetyPadded = parsed('r2-ui-safety-gate-zero-padded');
    assert.strictEqual(safetyPadded.block, safetyNumeric.block);
    assert.strictEqual(safetyPadded.hasUiSpec, safetyNumeric.hasUiSpec);
    assert.strictEqual(safetyNumeric.block, true);

    const tddNumeric = parsed('r2-tdd-review-checkpoint-numeric');
    const tddPadded = parsed('r2-tdd-review-checkpoint-zero-padded');
    assert.strictEqual(tddPadded.tddPlans, tddNumeric.tddPlans);
    assert.deepStrictEqual(tddPadded.rows, tddNumeric.rows);
    assert.strictEqual(tddNumeric.tddPlans, 1);
  });

  test('a missing phase and a phase escaping .planning both fail the lookup, never a spec hit', () => {
    for (const id of ['r2-ui-plan-gate-missing-phase', 'r2-ui-plan-gate-escapes-planning']) {
      const p = parsed(id);
      assert.strictEqual(p.phaseLookupFailed, true, `${id}: phaseLookupFailed`);
      assert.strictEqual(p.hasUiSpec, false, `${id}: no UI-SPEC`);
      assert.strictEqual(p.block, false, `${id}: not blocked`);
    }
    for (const id of ['r2-ui-safety-gate-missing-phase', 'r2-ui-safety-gate-escapes-planning']) {
      const p = parsed(id);
      assert.strictEqual(p.phaseLookupFailed, true, `${id}: phaseLookupFailed`);
      assert.strictEqual(p.hasUiSpec, false, `${id}: no UI-SPEC`);
      assert.strictEqual(p.block, false, `${id}: not blocked`);
    }
    for (const id of ['r2-tdd-review-checkpoint-missing-phase', 'r2-tdd-review-checkpoint-escapes-planning']) {
      const p = parsed(id);
      assert.strictEqual(p.tddPlans, 0, `${id}: no tdd plans resolved`);
      assert.deepStrictEqual(p.rows, [], `${id}: no rows`);
    }
  });
});

// ─── R4: readModifiedFilesContent caps ────────────────────────────────────────

describeGroup('R4 readModifiedFilesContent caps goldens', 'R4');

describe('R4 caps at limit-1, limit and limit+1 (real files, through decision-coverage-verify)', () => {
  const run = (fixture) => {
    const spec = arms.find((a) => a.gate === 'R4' && a.fixture === fixture);
    const actual = runArm(spec, rootFor(fixture));
    assert.strictEqual(actual.exitCode, 0);
    return JSON.parse(actual.stdout);
  };

  test('50-file cap: the 49th (limit-1) and 50th (limit) listed files are read; the 51st (limit+1) is not', () => {
    const out = run('cap-files');
    assert.strictEqual(out.total, 3);
    assert.strictEqual(out.honored, 2);
    assert.deepStrictEqual(out.not_honored.map((d) => d.id), ['D-03']);
  });

  test('256 KiB cap: content of 262143 (limit-1) and 262144 (limit) chars is intact; 262145 (limit+1) is truncated', () => {
    const out = run('cap-bytes');
    assert.strictEqual(out.total, 3);
    assert.strictEqual(out.honored, 2);
    assert.deepStrictEqual(out.not_honored.map((d) => d.id), ['D-03']);
  });
});

// ─── P1: decisionMentioned ────────────────────────────────────────────────────

describe('P1 decisionMentioned', () => {
  const { decisionMentioned } = router;
  const D = (id, text = 'short') => ({ id, text });

  // Hand-written reference table: [label, haystack, decision, expected].
  const TABLE = [
    ['empty haystack', '', D('D-01'), false],
    ['null haystack', null, D('D-01'), false],
    ['id as a whole token', 'See D-01 for details', D('D-01'), true],
    ['id followed by a digit is a different id', 'See D-011 for details', D('D-01'), false],
    ['id preceded by a letter has no word boundary', 'xD-01', D('D-01'), false],
    ['id in parentheses', '(D-01)', D('D-01'), true],
    ['id match is case-sensitive', 'd-01 lowercase', D('D-01'), false],
    ['id before a full stop', 'per D-01.', D('D-01'), true],
    ['unpadded id is a different id', 'D-1', D('D-01'), false],
    ['phase-prefixed id present', 'per D4-01', D('D4-01'), true],
    ['phase-prefixed id absent from plain id', 'per D-01', D('D4-01'), false],
    ['id followed by underscore is one word', 'D-01_x', D('D-01'), false],
    ['id glued to itself has no boundary', 'D-01D-01', D('D-01'), false],
    ['second of two ids', 'D-01 D-02', D('D-02'), true],
    ['id on its own line', 'line1\nD-05\nline3', D('D-05'), true],
    ['id between tabs', 'x\tD-05\ty', D('D-05'), true],
    ['longer id does not satisfy a shorter one', 'D-100', D('D-10'), false],
    ['shorter id does not satisfy a longer one', 'D-10', D('D-100'), false],
    ['soft phrase needs the same six words', 'we will use strict typing for all things', D('D-09', 'Use strict typing for all new modules'), false],
    ['soft phrase survives case and punctuation', 'We will USE strict, typing for ALL new modules!', D('D-09', 'Use strict typing for all new modules'), true],
    ['fewer than six words never soft-match', 'alpha beta gamma delta epsilon', D('D-09', 'alpha beta gamma delta epsilon'), false],
    ['exactly six words, hyphen is a separator', 'Alpha-beta gamma delta epsilon zeta', D('D-09', 'alpha beta gamma delta epsilon zeta'), true],
    ['an inserted word breaks the phrase', 'alpha beta gamma X delta epsilon zeta', D('D-09', 'alpha beta gamma delta epsilon zeta'), false],
    ['punctuated text normalises to six words', 'cache tokens in memory only please always', D('D-09', 'Cache: tokens, in-memory only please now'), true],
    ['phrase split across a newline', 'use strict\ntyping for all new modules', D('D-09', 'Use strict typing for all new modules'), true],
    ['digits are kept in the phrase', 'retry 3 times before giving up on it', D('D-09', 'Retry 3 times before giving up now'), true],
    ['punctuation-only haystack', '!!!', D('D-09', 'Use strict typing for all new modules'), false],
    ['phrase exactly at the end', 'note: use strict typing for all new', D('D-09', 'Use strict typing for all new modules'), true],
    ['a partial phrase is not enough', 'use strict typing for all', D('D-09', 'Use strict typing for all new modules'), false],
    ['non-ascii letters become separators', 'Café société ünïcode ranges', D('D-09', 'Café société ünïcode ranges are not ascii'), true],
  ];

  test('the reference table has 30 cases', () => {
    assert.strictEqual(TABLE.length, 30);
  });

  for (const [label, haystack, decision, expected] of TABLE) {
    test(`reference: ${label}`, () => {
      assert.strictEqual(decisionMentioned(haystack, decision), expected);
    });
  }

  const SEPARATORS = [' ', '\n', '\t', '.', ',', '(', ')', '-', '!', ':'];
  const separators = fc.array(fc.constantFrom(...SEPARATORS), { maxLength: 4 }).map((a) => a.join(''));
  const idArb = fc.tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 9 }))
    .map(([n, phase]) => (phase === 0 ? `D-${String(n).padStart(2, '0')}` : `D${phase}-${String(n).padStart(2, '0')}`));

  test('property: deterministic for any haystack and decision', () => {
    fc.assert(fc.property(fc.string(), idArb, fc.string(), (haystack, id, text) => {
      const decision = { id, text };
      return decisionMentioned(haystack, decision) === decisionMentioned(haystack, decision);
    }));
  });

  test('property: an id delimited by non-word characters is always mentioned', () => {
    fc.assert(fc.property(separators, idArb, separators, (pre, id, post) => {
      return decisionMentioned(`${pre}${id}${post}`, { id, text: 'short' }) === true;
    }));
  });

  test('property: a haystack of lowercase words that never spells the id never mentions a short decision', () => {
    const words = fc.array(fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'omega'), { maxLength: 8 }).map((a) => a.join(' '));
    fc.assert(fc.property(words, idArb, (haystack, id) => {
      return decisionMentioned(haystack, { id, text: 'short text' }) === false;
    }));
  });
});
