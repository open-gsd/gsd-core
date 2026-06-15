// Behavioral tests for the deterministic prohibition-enforcement producer (#1259, ADR-550 D5d
// "heavy half"). Requires the BUILT gsd-core/bin/lib/prohibition-enforcement.cjs — authored as
// src/prohibition-enforcement.cts and compiled by `npm run build:lib` (mirrors how the verify-tier
// suite requires the built probe-core.cjs). Typed-field assertions only; the check-runner is
// injected so no real subprocess is spawned. No source-grep.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ENFORCEMENT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'prohibition-enforcement.cjs');

const TEST_TIER = Object.freeze({
  requirement_id: 'R1',
  category: 'safety',
  status: 'resolved',
  verification: 'test',
  resolution: null,
  reason: null,
  statement: 'MUST NOT read source files and text-search them in tests',
});

describe('prohibition-enforcement: deterministic test-tier producer (#1259 / ADR-550 D5d)', () => {
  test('exports the producer + route functions', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.runProhibitionEnforcement, 'function',
      'must export runProhibitionEnforcement (the deterministic producer)');
    assert.equal(typeof enforce.routeProhibitionEnforcement, 'function',
      'must export routeProhibitionEnforcement (the CLI surface)');
  });

  test('locate-miss (no check descriptor) -> fail-closed, located:false, no evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(TEST_TIER, null, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'no locatable check');
    assert.notEqual(result.status, 'green', 'locate-miss must never be green');
    assert.equal(result.flagged, true, 'locate-miss must be flagged');
    assert.equal(result.kind, null, 'no kind when nothing located');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length === 0, 'no evidence on locate-miss');
  });

  test('malformed check descriptor (missing target) -> treated as locate-miss', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(TEST_TIER, { kind: 'node-test' }, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'a descriptor without a target is not locatable');
    assert.notEqual(result.status, 'green');
    assert.equal(result.flagged, true);
  });

  test('node-test check that passes -> green + non-empty typed evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ passed: true }) },
    );
    assert.equal(result.status, 'green');
    assert.equal(result.flagged, false);
    assert.equal(result.tier, 'test');
    assert.equal(result.located, true);
    assert.equal(result.kind, 'node-test');
    assert.equal(result.evidence.length, 1, 'one evidence record built');
    const ev = result.evidence[0];
    assert.equal(ev.kind, 'node-test');
    assert.equal(ev.target, 'tests/neg.test.cjs');
    assert.equal(ev.failFirst, true);
    assert.equal(ev.passed, true);
  });

  test('lint-rule (no-source-grep) check that passes -> green, evidence carries rule id', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/', failFirst: true },
      { runCheck: () => ({ passed: true }) },
    );
    assert.equal(result.status, 'green');
    assert.equal(result.flagged, false);
    assert.equal(result.kind, 'lint-rule');
    assert.equal(result.evidence[0].kind, 'lint-rule');
    assert.equal(result.evidence[0].rule, 'local/no-source-grep', 'evidence records which rule asserted the must-NOT');
    assert.equal(result.evidence[0].target, 'tests/', 'evidence records the linted target path, not the rule id');
  });

  test('buildLintArgs runs the project eslint as JSON over the target (plugins load via flat config; #1259 SF-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.buildLintArgs, 'function',
      'must export buildLintArgs — the eslint argv builder for the lint-rule real runner');
    const argv = enforce.buildLintArgs({ kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/' });
    assert.ok(Array.isArray(argv), 'argv is an array');
    const fmtIdx = argv.indexOf('--format');
    assert.ok(fmtIdx !== -1 && argv[fmtIdx + 1] === 'json',
      'emits --format json so the report can be filtered by ruleId');
    assert.ok(argv.includes('--no-warn-ignored'),
      'must pass --no-warn-ignored so an eslint-ignored target returns [] (fails closed), not a length-1 warning result');
    assert.ok(!argv.includes('--rule'),
      'must NOT use --rule — it cannot load a plugin rule like local/no-source-grep (the SF-01 bug)');
    assert.equal(argv[argv.length - 1], 'tests/', 'the LAST arg is the lint target path');
  });

  test('lint-rule descriptor missing its rule id -> locate-miss, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', target: 'tests/', failFirst: true }, // no `rule`
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green', 'a lint-rule with no rule id is not a valid wired check');
    assert.equal(result.flagged, true);
    assert.equal(result.located, false, 'an under-specified lint-rule descriptor is not locatable');
  });

  test('check that FAILS -> hard-gate (non-green, flagged), located:true, no evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ passed: false }) },
    );
    assert.notEqual(result.status, 'green');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true, 'the check was located even though it failed');
    assert.equal(result.evidence.length, 0, 'a failing check builds no evidence');
  });

  test('caller does NOT attest fail-first (descriptor failFirst:false) -> hard-gate, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // fail-first is caller-attested (#1259 BL-02): a check the caller does not attest as fail-first
    // is not a valid regression proof and must never green, even if the run passes.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: false },
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green', 'a non-attested check is not a valid regression proof');
    assert.equal(result.flagged, true);
  });

  test('a runCheck that THROWS fails closed, never propagates (no-throw contract, NEW-WR-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => { throw new Error('runner blew up'); } },
    );
    assert.notEqual(result.status, 'green', 'a throwing runner must never green');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true);
  });

  test('hard-gates in BOTH modes on a failing check (ADR-550 D4)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    for (const mode of ['interactive', 'autonomous']) {
      const result = enforce.runProhibitionEnforcement(
        TEST_TIER,
        { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
        { runCheck: () => ({ passed: false }), mode },
      );
      assert.notEqual(result.status, 'green', `non-green in ${mode}`);
      assert.equal(result.flagged, true, `flagged in ${mode}`);
      assert.equal(result.mode, mode, 'mode echoed for transparency');
    }
  });

  test('passing run echoes the requested mode without changing the green verdict', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ passed: true }), mode: 'autonomous' },
    );
    assert.equal(result.status, 'green', 'a passing wired check is green in autonomous mode too');
    assert.equal(result.mode, 'autonomous');
  });

  test('routeProhibitionEnforcement parses a JSON request file and emits a structured result', (t) => {
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    // Write a request file; the route reads it and runs the node-test descriptor's default runner
    // (its target does not exist, so it fail-closes deterministically — we assert the JSON SHAPE,
    // not a green verdict). We invoke the built CLI surface in a child process so output()
    // (writeAllSync to fd 1) is captured on stdout — no source-grep (we parse our own emitted JSON).
    const dir = createTempDir('prohib-enf-');
    const reqPath = path.join(dir, 'req.json');
    const runnerPath = path.join(dir, 'runner.cjs');
    fs.writeFileSync(reqPath, JSON.stringify({
      prohibition: TEST_TIER,
      check: { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      mode: 'autonomous',
    }));
    // A tiny runner that requires the BUILT module and invokes the route — output() writes to fd 1.
    fs.writeFileSync(runnerPath,
      "require(" + JSON.stringify(ENFORCEMENT_LIB) + ")" +
      ".routeProhibitionEnforcement(['check','prohibition-enforcement'," + JSON.stringify(reqPath) + "], false);\n");
    t.after(() => cleanup(dir));

    const captured = execFileSync('node', [runnerPath], { encoding: 'utf-8' });
    const parsed = JSON.parse(captured);
    assert.equal(typeof parsed, 'object', 'route emits a JSON object');
    assert.equal(parsed.tier, 'test', 'tier is preserved through the CLI surface');
    assert.equal(parsed.located, true, 'the check descriptor was located');
    assert.equal(parsed.mode, 'autonomous', 'mode flows through the CLI surface');
    assert.equal(typeof parsed.flagged, 'boolean', 'flagged is a typed boolean');
    assert.ok(Array.isArray(parsed.evidence), 'evidence is an array');
  });
});

// ─── Real-runner helpers (mutation-pinned; #1259 BL-01 / SF-01) ─────────────────
// These pin the deterministic parsing/threshold logic of the REAL runner so a Stryker mutant that
// weakens "non-vacuous pass" or the ruleId filter is caught — the contract the injected-runner tests
// above deliberately bypass.
describe('prohibition-enforcement real-runner helpers (#1259)', () => {
  test('parseNodeTestSummary extracts the TAP tests/pass/fail/cancelled counts', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.deepEqual(enforce.parseNodeTestSummary('# tests 3\n# pass 2\n# fail 1\n# cancelled 1\n'),
      { tests: 3, pass: 2, fail: 1, cancelled: 1 });
    assert.deepEqual(enforce.parseNodeTestSummary('no summary here'), { tests: 0, pass: 0, fail: 0, cancelled: 0 });
  });

  test('tapTestNames EXCLUDES skipped/todo tests (they never ran, m1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.deepEqual(enforce.tapTestNames('ok 1 - guards the must-NOT\nok 2 - other # SKIP\nok 3 - later # TODO\n'),
      ['guards the must-NOT'], 'a # SKIP / # TODO test is not a real run and must not count');
  });

  test('isNonVacuousNodeTestPass: a SKIPPED negative test (file wrapper passes) is NOT a pass (m1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // file wrapper + a skipped negative test: pass>=1 but the only named test is skipped -> vacuous.
    const skipped = 'ok 1 - empty.test.cjs\nok 2 - the negative test # SKIP\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(skipped, 'empty.test.cjs'), false,
      'a skipped negative test never executed -> must not green');
  });

  test('isNonVacuousNodeTestPass: a CANCELLED run is not a pass (m1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const cancelled = 'ok 1 - guards\n# tests 1\n# pass 1\n# fail 0\n# cancelled 1\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(cancelled, 'neg.test.cjs'), false,
      'a cancelled run is not a clean pass');
  });

  test('isNonVacuousNodeTestPass: an empty file (node names the test after the file) is NOT a pass (BL-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // node --test of a zero-test file: `ok 1 - empty.test.cjs`, `# tests 1 # pass 1` — counts alone
    // cannot distinguish it from a real test, so the file-named result must NOT count as a pass.
    const empty = 'ok 1 - empty.test.cjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(empty, 'empty.test.cjs'), false,
      'a file-named-only result is vacuous — the BL-01 false-green guard');
    // BASENAME-NORMALIZED: node may report the file-test by an ABSOLUTE/normalized path while the
    // descriptor target is relative (cross-OS / node-version). The basenames must still match → vacuous.
    const emptyAbs = 'ok 1 - /tmp/x/empty.test.cjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(emptyAbs, 'empty.test.cjs'), false,
      'an absolute-path file-test name must still be recognized as vacuous (basename compare, WR-02)');
    // Mirror case (pins the TARGET-side basename): relative TAP name vs ABSOLUTE descriptor target.
    const emptyRelName = 'ok 1 - neg.test.cjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(emptyRelName, '/abs/path/neg.test.cjs'), false,
      'a relative file-test name vs an absolute target must still be vacuous — both sides basename-normalized (WR-R4-01)');
    const real = 'ok 1 - guards the must-NOT\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(real, '/abs/path/neg.test.cjs'), true,
      'a real named test distinct from the file is a genuine pass (even vs an absolute target)');
    const failing = 'not ok 1 - guards\n# tests 1\n# pass 0\n# fail 1\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(failing, 'neg.test.cjs'), false,
      'any failure means not a pass');
  });

  test('eslintJsonHasRule detects a ruleId; unparseable report -> true (fail-closed)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(enforce.eslintJsonHasRule(JSON.stringify([{ messages: [{ ruleId: 'local/no-source-grep' }] }]), 'local/no-source-grep'), true);
    assert.equal(enforce.eslintJsonHasRule(JSON.stringify([{ messages: [{ ruleId: 'other' }] }]), 'local/no-source-grep'), false);
    assert.equal(enforce.eslintJsonHasRule('not json', 'local/no-source-grep'), true,
      'an unreadable report must be treated as a violation, never a silent pass');
  });

  test('eslintFileResultCount: 0 when nothing linted (vacuity guard)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(enforce.eslintFileResultCount(JSON.stringify([{}, {}])), 2);
    assert.equal(enforce.eslintFileResultCount('[]'), 0);
    assert.equal(enforce.eslintFileResultCount('garbage'), 0);
  });

  test('eslintHasFatalError: a parse/fatal error must fail closed (B1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const fatal = JSON.stringify([{ messages: [{ ruleId: null, fatal: true, severity: 2, message: 'Parsing error' }], fatalErrorCount: 1 }]);
    assert.equal(enforce.eslintHasFatalError(fatal), true, 'a fatal/parse error means the rule never ran -> fail closed');
    const clean = JSON.stringify([{ messages: [], fatalErrorCount: 0 }]);
    assert.equal(enforce.eslintHasFatalError(clean), false, 'a clean lint has no fatal error');
    assert.equal(enforce.eslintHasFatalError('not json'), true, 'an unreadable report is treated as fatal (fail closed)');
  });

  test('eslintJsonHasRule also reads suppressedMessages — an inline-disabled violation still counts (B1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const suppressed = JSON.stringify([{ messages: [], suppressedMessages: [{ ruleId: 'local/no-source-grep' }] }]);
    assert.equal(enforce.eslintJsonHasRule(suppressed, 'local/no-source-grep'), true,
      'a violation suppressed via // eslint-disable must NOT be treated as clean');
  });
});

// ─── Real runner end-to-end (NO injected runCheck; #1259 SF-02 / BL-01 / SF-01) ──
// Spawns real subprocesses so the SHIPPING default runner is exercised — the gap that let BL-01 and
// SF-01 slip past the injected-double tests. Typed-field assertions only.
describe('prohibition-enforcement REAL runner end-to-end (#1259)', () => {
  const fs = require('node:fs');

  test('a genuine non-vacuous passing node-test greens via the real runner', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-real-pass-');
    t.after(() => cleanup(dir));
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\nconst assert = require('node:assert');\ntest('guards the must-NOT', () => { assert.ok(true); });\n");
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true },
      { cwd: dir },
    );
    assert.equal(result.status, 'green', 'a real, passing, non-vacuous negative test must green');
    assert.equal(result.located, true);
    assert.equal(result.evidence.length, 1);
  });

  test('a HANGING node-test fails closed via the bounded timeout (B2: no unbounded subprocess)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-hang-');
    t.after(() => cleanup(dir));
    const tf = path.join(dir, 'hang.test.cjs');
    // A test that never returns; the bounded timeout must kill it and dispose non-green.
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\ntest('hangs forever', () => { while (true) {} });\n");
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true },
      { cwd: dir, timeoutMs: 1500 },
    );
    assert.notEqual(result.status, 'green', 'a hung check must be killed and fail closed — never hang verify or green');
    assert.equal(result.located, true);
  });

  test('an EMPTY node-test file (exit 0, zero tests) does NOT green via the real runner (BL-01)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-real-empty-');
    t.after(() => cleanup(dir));
    const tf = path.join(dir, 'empty.test.cjs');
    fs.writeFileSync(tf, '// intentionally empty — no test cases\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true },
      { cwd: dir },
    );
    assert.notEqual(result.status, 'green', 'an empty (zero-test) file must NEVER green — fail-closed');
    assert.equal(result.located, true, 'the check was located; it just did not genuinely pass');
    assert.equal(result.evidence.length, 0);
  });

  test('a clean in-tree target greens the lint-rule kind via the real eslint runner (SF-01: plugin loads)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Runs real `npx eslint --format json src/clock.cts` under the project flat config (so the
    // `local` plugin loads). src/clock.cts is a clean source with no no-source-grep violation.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'src/clock.cts', failFirst: true },
      { cwd: process.cwd() },
    );
    assert.equal(result.status, 'green', 'a clean target with no no-source-grep violation must green via real eslint');
    assert.equal(result.kind, 'lint-rule');
    assert.equal(result.evidence[0].rule, 'local/no-source-grep');
  });

  test('an eslint-IGNORED target does NOT green the lint-rule kind (vacuous-green guard, NEW-BL-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The generated bin/lib artifact is eslint-ignored. Without --no-warn-ignored, eslint returns a
    // length-1 "File ignored" result that would falsely pass the vacuity guard. It must fail closed.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'gsd-core/bin/lib/prohibition-enforcement.cjs', failFirst: true },
      { cwd: process.cwd() },
    );
    assert.notEqual(result.status, 'green', 'an ignored path lints nothing — must NEVER green');
    assert.equal(result.located, true, 'the descriptor was well-formed; it just did not genuinely pass');
  });
});
