'use strict';

/**
 * #5170 (epic #5056, ADR-5057 §4): the gate-evidence drift guard (scripts/lint-gate-evidence-drift.cjs).
 *
 * Matrix rows 35-37: the guard detects each forbidden shape, every positive-control fixture is
 * flagged while the clean fixture is not, and the census over the real tree is zero.
 *
 * The guard is AST-based; the fixtures under tests/fixtures/gate-evidence-drift/ are TypeScript
 * sources stored as `.cts.txt` so no compiler or linter walks a deliberately violating file.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const {
  scanText, scanSources, scanRepo, census, loadParser, RULES, ALLOWLIST, ROUTERS,
} = require('../scripts/lint-gate-evidence-drift.cjs');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'gate-evidence-drift');
const parser = loadParser(ROOT);

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

/** Positive controls: fixture, the host kind it is scanned as, and the exact rule set it must trip. */
const POSITIVE_CONTROLS = [
  { fixture: 'empty-catch.cts.txt', host: 'gate', rules: [RULES.EMPTY_CATCH] },
  // Its `return false` catch guards a `statSync`, so it is also the exists-collapse shape.
  { fixture: 'pass-shaped-catch.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE, RULES.PASS_SHAPED_CATCH] },
  { fixture: 'read-if-exists.cts.txt', host: 'any', rules: [RULES.READ_IF_EXISTS] },
  { fixture: 'exists-sync.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE] },
  // The same collapse written by hand: a `statSync` in a `try` whose `catch` answers `false` is also a pass-shaped catch.
  { fixture: 'stat-in-try-collapse.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE, RULES.PASS_SHAPED_CATCH] },
  { fixture: 'verb-process-exit-code.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-process-exit.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-numeric-return.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-direct-declare-outcome.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  // Its catch prints and exits 0: a swallowed exception on both counts.
  { fixture: 'verb-catch-no-exit.cts.txt', host: 'verb', rules: [RULES.PASS_SHAPED_CATCH, RULES.VERB_CATCH_NO_EXIT] },
  { fixture: 'unreadable-arm-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-branch-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  // ── Evasions of the first cut of the guard: each is the same defect written another way. ──
  // (b) a catch that neither rethrows nor produces unreadable evidence/verdict, whatever it returns.
  { fixture: 'catch-void-return.cts.txt', host: 'gate', rules: [RULES.PASS_SHAPED_CATCH] },
  { fixture: 'catch-return-constant.cts.txt', host: 'gate', rules: [RULES.PASS_SHAPED_CATCH] },
  { fixture: 'catch-assign-then-return.cts.txt', host: 'gate', rules: [RULES.PASS_SHAPED_CATCH] },
  { fixture: 'catch-record-only.cts.txt', host: 'gate', rules: [RULES.PASS_SHAPED_CATCH] },
  // (c) the unreadable arm written as an else, an alias, a fall-through, a `!== 'found'`, a helper...
  { fixture: 'unreadable-else-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-alias-outcome.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-fallthrough-case.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-not-found-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-helper-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-early-return-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-final-else-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-arm-identifier.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  // (d) the exists probe through a computed member, a destructuring, an aliased import, an alias assignment.
  { fixture: 'exists-computed-member.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE] },
  { fixture: 'exists-destructured.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE] },
  { fixture: 'exists-aliased-import.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE] },
  { fixture: 'exists-alias-assignment.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE] },
  { fixture: 'stat-aliased-collapse.cts.txt', host: 'gate', rules: [RULES.EXISTS_COLLAPSE, RULES.PASS_SHAPED_CATCH] },
];

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function scan(text, host, file = 'src/gate-fixture.cts') {
  return scanText(text, { file, hostKinds: [host], parser });
}

function ruleSet(violations) {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

describe('lint-gate-evidence-drift — detects each shape (matrix row 35)', () => {
  for (const control of POSITIVE_CONTROLS) {
    test(`${control.fixture} is flagged as ${control.rules.join(', ')}`, () => {
      const violations = scan(readFixture(control.fixture), control.host);
      assert.deepEqual(ruleSet(violations), [...control.rules].sort());
      assert.ok(violations.every((v) => Number.isInteger(v.line) && v.line > 0), 'every finding carries a line');
    });
  }

  test('the empty-catch fixture reports its one empty catch exactly once', () => {
    assert.equal(scan(readFixture('empty-catch.cts.txt'), 'gate').length, 1);
  });

  test('the pass-shaped fixture flags both literal-returning catches (return false, assign null)', () => {
    assert.equal(scan(readFixture('pass-shaped-catch.cts.txt'), 'gate').filter((v) => v.rule === RULES.PASS_SHAPED_CATCH).length, 2);
  });

  test('the unreadable-branch fixture flags the `if` arm and ignores the non-unreadable `case`/default arms', () => {
    assert.equal(scan(readFixture('unreadable-branch-pass.cts.txt'), 'gate').length, 1);
  });

  test('each unreadable-arm evasion reports its one passing verdict exactly once (no double report)', () => {
    for (const fixture of ['unreadable-else-pass', 'unreadable-alias-outcome', 'unreadable-fallthrough-case', 'unreadable-not-found-pass',
      'unreadable-helper-pass', 'unreadable-early-return-pass', 'unreadable-final-else-pass', 'unreadable-arm-identifier']) {
      assert.equal(scan(readFixture(`${fixture}.cts.txt`), 'gate').length, 1, fixture);
    }
  });

  test('each exists spelling is flagged: computed member, destructured, aliased import, alias assignment (call, .call, sequence)', () => {
    const count = (fixture) => scan(readFixture(`${fixture}.cts.txt`), 'gate').filter((v) => v.rule === RULES.EXISTS_COLLAPSE).length;
    assert.equal(count('exists-computed-member'), 1);
    assert.equal(count('exists-destructured'), 2);
    assert.equal(count('exists-aliased-import'), 1);
    assert.equal(count('exists-alias-assignment'), 3);
  });

  test('an alias of something that is not the fs module is not an exists probe (control)', () => {
    const text = "const { exists: present } = other;\nexport const f = (p: string) => present(p);";
    assert.equal(scan(text, 'gate').filter((v) => v.rule === RULES.EXISTS_COLLAPSE).length, 0);
  });
});

describe('lint-gate-evidence-drift — positive controls and the clean control (matrix row 36)', () => {
  test('every positive-control fixture is flagged (none is silently clean)', () => {
    for (const control of POSITIVE_CONTROLS) {
      assert.ok(scan(readFixture(control.fixture), control.host).length > 0, `${control.fixture} must be flagged`);
    }
  });

  test('the clean fixture is not flagged under any host kind', () => {
    for (const host of ['gate', 'verb', 'any']) {
      assert.deepEqual(scan(readFixture('clean.cts.txt'), host), [], `clean fixture scanned as ${host}`);
    }
  });

  test('fixing each violating fixture the sanctioned way turns it clean (the guard tracks the shape, not the file)', () => {
    const empty = readFixture('empty-catch.cts.txt').replace('// unreadable plan: ignored', 'evidenceFromError(new Error("x"), planPath);');
    assert.deepEqual(scan(empty, 'gate'), []);
    const passShaped = readFixture('pass-shaped-catch.cts.txt').replace(/return false;/, 'return evidenceFromError(err, target).kind === "none";').replace('value = null;\n  }', 'throw new Error("could not read");\n  }');
    assert.deepEqual(scan(passShaped, 'gate'), []);
    const arm = readFixture('unreadable-arm-pass.cts.txt').replace("unreadable: (reason) => gateVerdict('skip', false, { reason })", 'unreadable: (reason) => gateUnreadable(false, { reason })');
    assert.deepEqual(scan(arm, 'gate'), []);
    const catchNoExit = readFixture('verb-catch-no-exit.cts.txt').replace("output({ block: false, message: 'exception: ' + String(err) }, raw);", "output({ block: false }, raw);\n    declareGateExit(gateUnreadable(false, { block: false }), 'status');");
    assert.deepEqual(scan(catchNoExit, 'verb'), []);
  });

  test('a mutated clean fixture (the sanctioned catch turned into `return null`) is flagged', () => {
    const mutated = readFixture('clean.cts.txt').replace('return evidenceFromError<unknown>(err, span);', 'return null;');
    assert.deepEqual(ruleSet(scan(mutated, 'gate')), [RULES.PASS_SHAPED_CATCH]);
  });

  test('host scoping: `read-if-exists` applies to every source; the other rules do not leave their hosts', () => {
    assert.deepEqual(ruleSet(scan('try { a(); } catch {}', 'any')), []);
    assert.deepEqual(ruleSet(scan('const x = readIfExists;', 'any')), [RULES.READ_IF_EXISTS]);
    assert.deepEqual(ruleSet(scan('try { a(); } catch {}', 'gate')), [RULES.EMPTY_CATCH]);
  });

  test('verb hosts: only the discovered entry functions are in scope, a helper beside them is not', () => {
    const helper = 'function helper() { try { a(); } catch {} process.exitCode = 2; }';
    const scanVerb = (text, scopeNames) => scanText(text, { file: 'src/verb-fixture.cts', hostKinds: ['verb'], parser, scopeNames });
    assert.deepEqual(scanVerb(helper, ['cmdPhaseUatPassed']), []);
    const entry = 'function cmdPhaseUatPassed() { try { a(); } catch {} }';
    assert.deepEqual(ruleSet(scanVerb(entry, ['cmdPhaseUatPassed'])), [RULES.EMPTY_CATCH]);
    // Scope is the discovered set, not a hard-coded name: the same function, not named, is out of scope.
    assert.deepEqual(scanVerb(entry, []), []);
  });

  test('exists-collapse in a verb host applies inside the verb scope only', () => {
    const text = 'function cmdFixture() { return fs.existsSync(p); }\nfunction helper() { return fs.existsSync(q); }';
    const scanVerb = (scopeNames) => scanText(text, { file: 'src/verb-fixture.cts', hostKinds: ['verb'], parser, scopeNames });
    assert.deepEqual(scanVerb(['cmdFixture']).map((v) => v.symbol), ['cmdFixture']);
    assert.deepEqual(scanVerb([]), []);
  });

  test('exists-collapse boundaries: a statSync in try with a rethrowing / evidence-returning catch is not flagged', () => {
    const flagged = (body) => ruleSet(scan(`function f() { try { return fs.statSync(p); } catch (err) { ${body} } }`, 'gate'));
    assert.deepEqual(flagged('return false;'), [RULES.EXISTS_COLLAPSE, RULES.PASS_SHAPED_CATCH]);
    assert.deepEqual(flagged('return null;'), [RULES.EXISTS_COLLAPSE, RULES.PASS_SHAPED_CATCH]);
    assert.deepEqual(flagged('throw err;'), []);
    assert.deepEqual(flagged('return evidenceFromError(err, p);'), []);
    // A statSync OUTSIDE the try block (in the handler or after it) is not the collapsed probe.
    assert.deepEqual(ruleSet(scan('function f() { try { a(); } catch (err) { throw err; } return fs.statSync(p); }', 'gate')), []);
  });

  test('the exit seam itself (src/gate-exit.cts) may declare the outcome; any other gate module may not', () => {
    const declaring = "import cliExit = require('./cli-exit.cjs'); export function declareGateExit() { cliExit.declareOutcome('FAIL'); }";
    assert.deepEqual(scan(declaring, 'gate', 'src/gate-exit.cts'), []);
    assert.deepEqual(ruleSet(scan(declaring, 'gate', 'src/gate-other.cts')), [RULES.VERB_OWNS_EXIT]);
  });
});

describe('lint-gate-evidence-drift — catch boundaries: limit-1 / limit / limit+1 statements', () => {
  const flagged = (body) => scan(`function f() { try { a(); } catch (err) { ${body} } }`, 'gate').length;

  test('0 statements is an empty catch', () => {
    assert.equal(flagged(''), 1);
  });

  test('1 literal statement is pass-shaped', () => {
    assert.equal(flagged('return true;'), 1);
  });

  test('1 call statement that merely records the error is flagged (handing it to a logger is not handling it)', () => {
    assert.equal(flagged('record(err);'), 1);
  });

  test('2 statements, one a recording call, are flagged: only a rethrow or unreadable evidence handles the failure', () => {
    assert.equal(flagged('record(err); return null;'), 1);
  });

  test('2 literal statements are pass-shaped', () => {
    assert.equal(flagged("ok = false; return '';"), 1);
  });

  test('`void err; return \'\'`, a named empty constant and an assignment then a return are all flagged', () => {
    assert.equal(flagged("void err; return '';"), 1);
    assert.equal(flagged('return EMPTY;'), 1);
    assert.equal(flagged("value = ''; return value;"), 1);
  });

  test('a rethrow or a typed-evidence return is not flagged', () => {
    assert.equal(flagged('throw err;'), 0);
    assert.equal(flagged('return evidenceFromError(err, "span");'), 0);
    assert.equal(flagged('return { kind: "unreadable", reason: String(err) };'), 0);
    assert.equal(flagged('unreadable.push(String(err));'), 0);
    assert.equal(flagged('return gateUnreadable(true, { reason: String(err) });'), 0);
    assert.equal(flagged('error("could not run: " + String(err));'), 0);
  });

  test('one handling statement among others clears the catch (a rethrow after a record)', () => {
    assert.equal(flagged('record(err); throw err;'), 0);
  });
});

describe('lint-gate-evidence-drift — property: a catch is flagged exactly when it neither rethrows nor produces unreadable evidence', () => {
  const literalStatement = fc.constantFrom('return true;', 'return false;', 'return null;', "return '';", 'return [];', 'return {};', 'return undefined;', 'ok = false;', 'value = null;',
    'void err;', 'return EMPTY;', 'record(err);', "text = ''; return text;");
  const callStatement = fc.constantFrom('return evidenceFromError(err, "s");', 'throw err;', 'unreadable.push(String(err));', 'return gateUnreadable(false, {});');

  test('a catch without a handling statement is always flagged, whatever it answers (seeded)', () => {
    fc.assert(
      fc.property(fc.array(literalStatement, { minLength: 1, maxLength: 6 }), (body) => {
        const violations = scan(`function f() { try { a(); } catch (err) { ${body.join(' ')} } }`, 'gate');
        return violations.length === 1 && violations[0].rule === RULES.PASS_SHAPED_CATCH;
      }),
      { seed: 5170, numRuns: 100 },
    );
  });

  test('a catch holding at least one handling statement is never flagged, wherever it sits (seeded)', () => {
    fc.assert(
      fc.property(
        fc.array(literalStatement, { maxLength: 4 }),
        callStatement,
        fc.array(literalStatement, { maxLength: 4 }),
        (before, call, after) => {
          const body = [...before, call, ...after].join(' ');
          return scan(`function f() { try { a(); } catch (err) { ${body} } }`, 'gate').length === 0;
        },
      ),
      { seed: 5170, numRuns: 100 },
    );
  });
});

describe('lint-gate-evidence-drift — fail-closed', () => {
  function scratchRoot(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gate-evidence-drift-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'src', name), content);
    return dir;
  }

  test('a tree with no gate hosts and no verb hosts is a problem, not a clean scan', () => {
    const result = scanRepo(scratchRoot({ 'other.cts': 'export const x = 1;\n' }), parser, { routers: [] });
    assert.deepEqual(result.violations, []);
    assert.equal(result.problems.length, 2);
  });

  test('a gate host the parser cannot read fails the scan instead of being skipped', () => {
    const dir = scratchRoot({ 'gate-broken.cts': 'export const = ;\n' });
    assert.throws(() => scanRepo(dir, parser, { routers: [] }));
  });

  test('a gate host with an empty catch, in a scratch tree, is reported with its file and line', () => {
    const dir = scratchRoot({
      'gate-fixture.cts': 'export function f() {\n  try { a(); } catch {}\n}\n',
      'verb-fixture.cts': "import { declareGateExit } from './gate-exit.cjs';\nexport function cmd() { declareGateExit(gateVerdict('pass', false, {}), 'status'); }\n",
    });
    const result = scanRepo(dir, parser, { routers: [] });
    assert.deepEqual(result.violations, [{ file: 'src/gate-fixture.cts', rule: RULES.EMPTY_CATCH, line: 2, symbol: 'f' }]);
    assert.deepEqual(result.verbHosts, ['src/verb-fixture.cts']);
  });
});

describe('lint-gate-evidence-drift — census over the real tree (matrix row 37)', () => {
  test('the allowlist holds exactly one justified site: `missingOnDisk` in finalizeFiles (gate-evaluation-scope)', () => {
    assert.ok(Array.isArray(ALLOWLIST) && Object.isFrozen(ALLOWLIST));
    assert.deepEqual(
      ALLOWLIST.map(({ file, rule, symbol }) => ({ file, rule, symbol })),
      [{ file: 'src/gate-evaluation-scope.cts', rule: RULES.EXISTS_COLLAPSE, symbol: 'finalizeFiles' }],
    );
    assert.match(ALLOWLIST[0].reason, /ADR-5057/);
    assert.match(ALLOWLIST[0].reason, /missingOnDisk/);
  });

  test('the allowlisted site is real and tolerated: without the entry it is the one finding, with it the tree is clean', () => {
    const withoutAllowlist = scanRepo(ROOT, parser, { allowlist: [] });
    assert.deepEqual(
      withoutAllowlist.violations.map(({ file, rule, symbol }) => ({ file, rule, symbol })),
      [{ file: 'src/gate-evaluation-scope.cts', rule: RULES.EXISTS_COLLAPSE, symbol: 'finalizeFiles' }],
    );
    const tolerated = scanRepo(ROOT, parser);
    assert.deepEqual(tolerated.violations, []);
    assert.equal(tolerated.allowlisted.length, 1);
  });

  test('a stale allowlist entry (matching nothing) is a problem, not silently kept', () => {
    const stale = { file: 'src/gate-evaluation-scope.cts', rule: RULES.EXISTS_COLLAPSE, symbol: 'noSuchFunction', reason: 'ADR-5057' };
    const result = scanRepo(ROOT, parser, { allowlist: [...ALLOWLIST, stale] });
    assert.ok(result.problems.some((p) => /noSuchFunction/.test(p)), JSON.stringify(result.problems));
  });

  test('the census is zero in every class, over a non-trivial set of hosts', () => {
    const counts = census(ROOT, parser);
    assert.deepEqual(counts.problems, []);
    assert.ok(counts.gateHosts > 15, `expected the gate modules to be scanned, saw ${counts.gateHosts}`);
    assert.ok(counts.verbHosts >= 3, `expected the gate verb hosts (router, phase, verify), saw ${counts.verbHosts}`);
    assert.ok(counts.entries >= 20, `expected the discovered gate verb entries, saw ${counts.entries}`);
    assert.equal(counts.emptyCatches, 0);
    assert.equal(counts.passShapedCatches, 0);
    assert.equal(counts.readIfExists, 0);
    assert.equal(counts.existsCollapse, 0);
    assert.equal(counts.verbOwnsExit, 0);
    assert.equal(counts.unreadableArmPasses, 0);
    assert.equal(counts.verbCatchNoExit, 0);
    assert.equal(counts.verbNoGateExit, 0);
    assert.equal(counts.verdictOwnsExit, 0);
    assert.equal(counts.allowlisted, 1, 'the one tolerated, named site');
    assert.equal(counts.total, 0);
  });

  test('the verb hosts are discovered from the gate-exit importers, and include the three known consumers', () => {
    const { verbHosts } = scanRepo(ROOT, parser);
    for (const file of ['src/check-command-router.cts', 'src/phase.cts', 'src/verify.cts']) {
      assert.ok(verbHosts.includes(file), `${file} imports the exit seam and must be scanned as a verb host`);
    }
  });
});

describe('lint-gate-evidence-drift — gate verb entries are discovered, not listed', () => {
  const GATE_STUB = { file: 'src/gate-stub.cts', text: 'export const stub = 1;\n' };
  const ROUTER = 'src/verify-command-router.cts';

  function tree(extra) {
    return scanSources([GATE_STUB, ...extra], parser, { routers: [ROUTERS[0]], allowlist: [] });
  }

  test('the real routers discover the verbs the phase wires, by name, from the dispatch tables', () => {
    const { entries } = scanRepo(ROOT, parser);
    const names = (router) => entries.filter((e) => e.router === router).map((e) => e.name);
    for (const name of ['cmdVerifyPlanStructure', 'cmdVerifyPhaseCompleteness', 'cmdVerifyReferences', 'cmdVerifyCommits',
      'cmdVerifyArtifacts', 'cmdVerifyKeyLinks', 'cmdVerifySchemaDrift', 'cmdVerifyCodebaseDrift', 'cmdVerifyContextDrift']) {
      assert.ok(names('verify').includes(name), `${name} is dispatched by the verify router`);
    }
    assert.deepEqual(names('phase'), ['cmdPhaseUatPassed']);
    for (const name of ['cmdUiPlanGate', 'cmdTddReviewCheckpoint', 'cmdApiCoverageVerifyPre', 'cmdCheckPredicate', 'routeProhibitionEnforcement']) {
      assert.ok(names('check').includes(name), `${name} is dispatched by the check router`);
    }
  });

  test('a router that yields no entries is a problem, not a clean scan (fail-closed)', () => {
    const result = tree([{ file: ROUTER, text: 'export function routeVerifyCommand() {}\n' }]);
    assert.ok(result.problems.some((p) => /yielded no gate verb entries/.test(p)), JSON.stringify(result.problems));
  });

  test('a router file that was not scanned is a problem', () => {
    const result = tree([]);
    assert.ok(result.problems.some((p) => /was not scanned/.test(p)), JSON.stringify(result.problems));
  });

  test('a dispatched entry with no definition is a problem', () => {
    const result = tree([{ file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') }]);
    assert.ok(result.problems.some((p) => /cmdFixtureVerb .* has no definition/.test(p)), JSON.stringify(result.problems));
  });

  test('verb-no-gate-exit: a dispatched verb that prints its verdict and never declares its exit is flagged (positive control)', () => {
    const result = tree([
      { file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') },
      { file: 'src/verb-fixture.cts', text: readFixture('verb-no-gate-exit.cts.txt') },
    ]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(
      result.violations.filter((v) => v.rule === RULES.VERB_NO_GATE_EXIT).map(({ file, symbol }) => ({ file, symbol })),
      [{ file: 'src/verb-fixture.cts', symbol: 'cmdFixtureVerb' }],
    );
  });

  test('verb-no-gate-exit: the same verb is clean once it reaches declareGateExit, directly or through a helper', () => {
    const direct = readFixture('verb-no-gate-exit.cts.txt').replace('output({ valid: false, errors: [\'something is wrong\'] }, raw);', 'output({ valid: false }, raw);\n  declareGateExit(gateVerdict(\'block\', true, {}), \'status\');');
    assert.ok(direct.includes('declareGateExit'));
    const viaHelper = [
      "import { output } from './io.cjs';",
      "import { declareGateExit } from './gate-exit.cjs';",
      'function emit(raw: boolean): void { output({ valid: false }, raw); declareGateExit(verdict, "status"); }',
      'export function cmdFixtureVerb(raw: boolean): void { emit(raw); }',
    ].join('\n');
    for (const text of [direct, viaHelper]) {
      const result = tree([
        { file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') },
        { file: 'src/verb-fixture.cts', text },
      ]);
      assert.deepEqual(result.violations.filter((v) => v.rule === RULES.VERB_NO_GATE_EXIT), []);
    }
  });

  const verbTree = (...files) => tree([
    { file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') },
    ...files.map(([file, name]) => ({ file, text: readFixture(name) })),
  ]);
  const noGateExit = (result) => result.violations.filter((v) => v.rule === RULES.VERB_NO_GATE_EXIT).map(({ file, symbol, line }) => ({ file, symbol, line }));

  test('verb-no-gate-exit: an early `output({ error }); return;` beside a branch that declares the exit is flagged (the #4686 shape)', () => {
    const result = verbTree(['src/verb-fixture.cts', 'verb-early-return-output.cts.txt']);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(noGateExit(result), [{ file: 'src/verb-fixture.cts', symbol: 'cmdFixtureVerb', line: 16 }]);
  });

  test('verb-no-gate-exit: a path that falls off the end of the verb without declaring the exit is flagged', () => {
    const result = verbTree(['src/verb-fixture.cts', 'verb-fallthrough-end.cts.txt']);
    assert.deepEqual(noGateExit(result).map((v) => v.symbol), ['cmdFixtureVerb']);
  });

  test('verb-no-gate-exit: every path settled (helper closure, error(), throw, try and catch, switch) is clean (negative control)', () => {
    const result = verbTree(['src/verb-fixture.cts', 'verb-all-paths-settled.cts.txt']);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(noGateExit(result), []);
  });

  test('verb-no-gate-exit: helper closures resolve per file and symbol — an `emit` that settles in ANOTHER file does not settle this verb', () => {
    const result = verbTree(['src/verb-fixture.cts', 'verb-helper-collision.cts.txt'], ['src/unrelated.cts', 'helper-collision-other.cts.txt']);
    assert.deepEqual(noGateExit(result).map((v) => v.symbol), ['cmdFixtureVerb']);
  });

  test('verb-no-gate-exit: an imported helper settles the verb when the import names it (per symbol)', () => {
    const entry = [
      "import { emit } from './unrelated.cjs';",
      'export function cmdFixtureVerb(raw: boolean): void { emit({ valid: true }, raw); }',
    ].join('\n');
    const result = tree([
      { file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') },
      { file: 'src/verb-fixture.cts', text: entry },
      { file: 'src/unrelated.cts', text: readFixture('helper-collision-other.cts.txt') },
    ]);
    assert.deepEqual(noGateExit(result), []);
  });

  test('verb-no-gate-exit boundaries: return paths limit-1 / limit / limit+1 — the unsettled one is found wherever it is', () => {
    const body = (unsettledAt, paths) => {
      const lines = [];
      for (let i = 0; i < paths; i += 1) {
        lines.push(i === unsettledAt ? `if (p${i}) { output({}, raw); return; }` : `if (p${i}) { declareGateExit(v, 'status'); return; }`);
      }
      lines.push("declareGateExit(v, 'status');");
      return `import { output } from './io.cjs';\nimport { declareGateExit } from './gate-exit.cjs';\nexport function cmdFixtureVerb(raw: boolean): void { ${lines.join(' ')} }`;
    };
    for (const paths of [1, 2, 3]) {
      assert.equal(noGateExit(tree([{ file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') }, { file: 'src/verb-fixture.cts', text: body(-1, paths) }])).length, 0, `${paths} settled paths`);
      for (let at = 0; at < paths; at += 1) {
        const flagged = noGateExit(tree([{ file: ROUTER, text: readFixture('verb-no-gate-exit-router.cts.txt') }, { file: 'src/verb-fixture.cts', text: body(at, paths) }]));
        assert.equal(flagged.length, 1, `${paths} paths, path ${at} unsettled`);
      }
    }
  });

  test('verdict-owns-exit: a function anywhere that prints a verdict-shaped payload and sets the exit itself is flagged (positive control)', () => {
    const result = tree([{ file: 'src/other.cts', text: readFixture('verdict-owns-exit.cts.txt') }]);
    assert.deepEqual(
      result.violations.filter((v) => v.rule === RULES.VERDICT_OWNS_EXIT).map(({ file, symbol }) => ({ file, symbol })),
      [{ file: 'src/other.cts', symbol: 'cmdFixtureReport' }],
    );
  });

  test('verdict-owns-exit boundaries: a non-verdict payload, or declaring the exit through the seam, is not flagged', () => {
    const flagged = (text) => tree([{ file: 'src/other.cts', text }]).violations.filter((v) => v.rule === RULES.VERDICT_OWNS_EXIT).length;
    assert.equal(flagged("function f(raw) { output({ items: [] }, raw); process.exitCode = 1; }"), 0);
    assert.equal(flagged("function f(raw) { output({ valid: true }, raw); }"), 0);
    assert.equal(flagged("function f(raw) { const r = { block: true }; output(r, raw); process.exitCode = 1; }"), 1);
    assert.equal(flagged("function f(raw) { output({ block: true }, raw); process.exitCode = 1; declareGateExit(v, 'status'); }"), 0);
    for (const key of ['passed', 'valid', 'all_passed', 'block', 'blocking', 'drift_detected']) {
      assert.equal(flagged(`function f(raw) { output({ ${key}: true }, raw); process.exitCode = 1; }`), 1, key);
    }
  });
});
