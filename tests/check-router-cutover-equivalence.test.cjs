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
  assert.deepStrictEqual(golden.env, spec.env, 'golden environment is the arm environment');
  const actual = runArm(spec, rootFor(spec.fixture));
  assert.strictEqual(actual.outcome, 'exited', 'the gate subprocess exited on its own');
  if (spec.changed) {
    // A DELIBERATE change (#5219): the golden is the origin/next answer and stays the provenance record;
    // the move answers differently, and that answer is pinned here.
    const before = JSON.parse(golden.stdout);
    const after = JSON.parse(actual.stdout);
    assert.notStrictEqual(before.reason, spec.changed.reason, `${spec.id}: the golden records the pre-move answer`);
    assert.strictEqual(after.reason, spec.changed.reason, `${spec.id}: reason`);
    assert.strictEqual(after.block, false, `${spec.id}: stays non-blocking`);
    assert.strictEqual(after.skipped, true, `${spec.id}: not a comparison`);
    assert.strictEqual(after.last_mapped_commit, before.last_mapped_commit, `${spec.id}: the stamp is reported as read`);
    assert.strictEqual(actual.exitCode, spec.changed.exitCode, `${spec.id}: exit code`);
    return;
  }
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

describe('gate failure codes are ERROR_REASON values (parity)', () => {
  test('every GATE_FAILURE_CODE equals an ERROR_REASON wire string, so the router passes it to error() as a known reason', () => {
    const { GATE_FAILURE_CODE } = require('../gsd-core/bin/lib/gate-verdict.cjs');
    const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
    const reasons = new Set(Object.values(ERROR_REASON));
    for (const [name, code] of Object.entries(GATE_FAILURE_CODE)) {
      assert.ok(reasons.has(code), `GATE_FAILURE_CODE.${name} (${code}) is not an ERROR_REASON value`);
    }
    assert.strictEqual(GATE_FAILURE_CODE.UNKNOWN, ERROR_REASON.UNKNOWN);
    assert.strictEqual(GATE_FAILURE_CODE.SDK_MISSING_ARG, ERROR_REASON.SDK_MISSING_ARG);
    assert.strictEqual(GATE_FAILURE_CODE.USAGE, ERROR_REASON.USAGE);
  });

  test('the drift verbs\' usage failures keep the pre-move reason (unknown): JSON diagnostics and exit-contract v2 are unchanged', () => {
    for (const id of ['verify-schema-drift-no-arg-json-errors', 'verify-surface-schema-drift-no-arg-json-errors', 'verify-context-drift-no-arg-json-errors']) {
      assert.strictEqual(JSON.parse(readGolden(id).stderr).reason, 'unknown', id);
    }
    for (const id of ['verify-schema-drift-no-arg-contract-v2', 'verify-surface-schema-drift-no-arg-contract-v2', 'verify-context-drift-no-arg-contract-v2']) {
      assert.strictEqual(readGolden(id).exitCode, 1, `${id}: UNKNOWN is FAIL (1), not USAGE (64)`);
    }
    assert.strictEqual(readGolden('prohibition-enforcement-no-arg-contract-v2').exitCode, 64, 'prohibition-enforcement always named SDK_MISSING_ARG');
  });
});

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
// #5219 (ADR-5057 §4 arm C): the four gates moved out of verify.cts / prohibition-enforcement.cts into
// gate modules. Goldens were captured by executing the code BEFORE the move (the `verify` surface arms
// included: `verify schema-drift|codebase-drift|context-drift` reach the same gates).
describeGroup('E12 verify-schema-drift', 'E12');
describeGroup('E13 verify-codebase-drift', 'E13');
describeGroup('E14 verify-context-drift', 'E14');
describeGroup('E15 prohibition-enforcement', 'E15');
describeGroup('auto-mode', 'auto');
describeGroup('dispatcher', 'dispatch');

// ─── #5170: the exit status follows the verdict (the goldens above pin every arm's exit code) ───

describe('exit status follows the verdict (#5170, ADR-5057 §4)', () => {
  const UNAVAILABLE = 69;
  function runById(id) {
    const spec = arms.find((a) => a.id === id);
    assert.ok(spec, `${id} is an arm of the catalogue`);
    const actual = runArm(spec, rootFor(spec.fixture));
    assert.strictEqual(actual.outcome, 'exited', `${id}: the gate subprocess exited on its own`);
    return { actual, payload: JSON.parse(actual.stdout) };
  }

  test('ui-safety-gate with an unresolvable scope: policy unchanged (block:false), JSON unchanged, exit UNAVAILABLE', () => {
    for (const id of ['r2-ui-safety-gate-missing-phase', 'r2-ui-safety-gate-escapes-planning']) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.scopeStatus, 'unresolvable', `${id}: the payload still says unresolvable`);
      assert.strictEqual(payload.block, false, `${id}: block stays the gate's own policy`);
      assert.strictEqual(actual.exitCode, UNAVAILABLE, `${id}: "could not look" is never exit 0`);
    }
  });

  test('the two verify probes that cannot look: JSON status unresolvable unchanged, exit UNAVAILABLE', () => {
    for (const id of [
      'verify-command-paths-no-arg',
      'verify-command-paths-dir-escapes-root',
      'verify-command-paths-phase-unresolved',
      'verify-failure-directions-no-arg',
      'verify-failure-directions-phase-unresolved',
    ]) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.status, 'unresolvable', `${id}: status`);
      assert.strictEqual(typeof payload.readError, 'string', `${id}: readError`);
      assert.deepStrictEqual(payload.commands, [], `${id}: commands`);
      assert.strictEqual(actual.exitCode, UNAVAILABLE, `${id}: exit status`);
    }
  });

  test('control: a probe that could look exits 0 with its payload', () => {
    const { actual, payload } = runById('verify-command-paths-dir-flag');
    assert.notStrictEqual(payload.status, 'unresolvable');
    assert.strictEqual(actual.exitCode, 0);
  });

  test('a delivered BLOCKING verdict stays exit 0 (payload mode: the dispatch reads .block from stdout)', () => {
    for (const id of ['decision-coverage-plan-could-not-parse', 'decision-coverage-plan-uncovered']) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.passed, false, `${id}: the verdict is negative`);
      assert.strictEqual(actual.exitCode, 0, `${id}: a delivered verdict is not a command failure`);
    }
  });

  test('api-coverage: an unreadable COVERAGE.md and an unreadable plan are UNAVAILABLE; a delivered block is not', () => {
    for (const id of ['api-coverage-verify-pre-coverage-unreadable', 'api-coverage-verify-pre-scope-read-error']) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.block, true, `${id}: the fail-closed policy is unchanged`);
      assert.strictEqual(actual.exitCode, UNAVAILABLE, `${id}: exit status`);
    }
    const detected = runById('api-coverage-verify-pre-detected');
    assert.strictEqual(detected.payload.block, true);
    assert.strictEqual(detected.actual.exitCode, 0, 'a delivered block is exit 0');
  });

  test('the drift gates: a delivered block is exit 0, "could not look" is UNAVAILABLE, a non-answer skip is exit 0 (#5219)', () => {
    for (const id of ['verify-schema-drift-blocks', 'verify-codebase-drift-blocks', 'verify-context-drift-stale-blocks']) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.block, true, `${id}: the verdict blocks`);
      assert.strictEqual(actual.exitCode, 0, `${id}: a delivered block is not a command failure`);
    }
    for (const id of [
      'verify-schema-drift-phase-not-found',
      'verify-schema-drift-plan-unreadable',
      'verify-codebase-drift-unresolvable-mapped-commit',
      'verify-codebase-drift-non-commit-baseline',
      'verify-codebase-drift-document-unreadable',
      'verify-context-drift-phase-not-found',
    ]) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.block, false, `${id}: the non-blocking contract holds`);
      assert.strictEqual(actual.exitCode, UNAVAILABLE, `${id}: "could not look" is never exit 0`);
    }
    for (const id of ['verify-schema-drift-no-phases-dir', 'verify-codebase-drift-no-structure-md', 'verify-context-drift-no-context-md']) {
      const { actual, payload } = runById(id);
      assert.strictEqual(payload.block, false, `${id}: a skip does not block`);
      assert.strictEqual(actual.exitCode, 0, `${id}: "nothing to compare" is exit 0`);
    }
  });

  test('schema-drift: the env bypass reaches the gate through the check surface only; the verify surface reads --skip (#5219)', () => {
    assert.strictEqual(runById('verify-schema-drift-env-skip').payload.block, false, 'GSD_SKIP_SCHEMA_CHECK=true bypasses on the check surface');
    assert.strictEqual(runById('verify-schema-drift-env-not-true').payload.block, true, 'only the exact string "true" bypasses');
    assert.strictEqual(runById('verify-surface-schema-drift-skip-flag').payload.block, false, '--skip bypasses on the verify surface');
    assert.strictEqual(runById('verify-surface-schema-drift-env-ignored').payload.block, true, 'the verify surface does not read the env flag');
  });
});

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
