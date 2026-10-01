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
  scanText, scanRepo, census, loadParser, RULES, ALLOWLIST,
} = require('../scripts/lint-gate-evidence-drift.cjs');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'gate-evidence-drift');
const parser = loadParser(ROOT);

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

/** Positive controls: fixture, the host kind it is scanned as, and the exact rule set it must trip. */
const POSITIVE_CONTROLS = [
  { fixture: 'empty-catch.cts.txt', host: 'gate', rules: [RULES.EMPTY_CATCH] },
  { fixture: 'pass-shaped-catch.cts.txt', host: 'gate', rules: [RULES.PASS_SHAPED_CATCH] },
  { fixture: 'read-if-exists.cts.txt', host: 'any', rules: [RULES.READ_IF_EXISTS] },
  { fixture: 'verb-process-exit-code.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-process-exit.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-numeric-return.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-direct-declare-outcome.cts.txt', host: 'verb', rules: [RULES.VERB_OWNS_EXIT] },
  { fixture: 'verb-catch-no-exit.cts.txt', host: 'verb', rules: [RULES.VERB_CATCH_NO_EXIT] },
  { fixture: 'unreadable-arm-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
  { fixture: 'unreadable-branch-pass.cts.txt', host: 'gate', rules: [RULES.UNREADABLE_ARM_PASSES] },
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
    assert.equal(scan(readFixture('pass-shaped-catch.cts.txt'), 'gate').length, 2);
  });

  test('the unreadable-branch fixture flags the `if` arm and ignores the non-unreadable `case`/default arms', () => {
    assert.equal(scan(readFixture('unreadable-branch-pass.cts.txt'), 'gate').length, 1);
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
    const passShaped = readFixture('pass-shaped-catch.cts.txt').replace(/return false;/, 'return statEvidence(target).kind === "found";').replace('value = null;\n  }', 'record(value);\n  }');
    assert.deepEqual(scan(passShaped, 'gate'), []);
    const arm = readFixture('unreadable-arm-pass.cts.txt').replace("unreadable: (reason) => gateVerdict('skip', false, { reason })", 'unreadable: (reason) => gateUnreadable(false, { reason })');
    assert.deepEqual(scan(arm, 'gate'), []);
    const catchNoExit = readFixture('verb-catch-no-exit.cts.txt').replace("output({ block: false, message: 'exception: ' + String(err) }, raw);", "output({ block: false }, raw);\n    declareGateExit({ outcome: 'unreadable' }, 'status');");
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

  test('verb hosts: only gate verb entry functions are in scope, a helper beside them is not', () => {
    const helper = 'function helper() { try { a(); } catch {} process.exitCode = 2; }';
    assert.deepEqual(scan(helper, 'verb', 'src/verb-fixture.cts'), []);
    const entry = 'function cmdPhaseUatPassed() { try { a(); } catch {} }';
    assert.deepEqual(ruleSet(scan(entry, 'verb', 'src/verb-fixture.cts')), [RULES.EMPTY_CATCH]);
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

  test('1 call statement is not (the failure is handed to something)', () => {
    assert.equal(flagged('record(err);'), 0);
  });

  test('2 statements, one a call, are not pass-shaped (every statement must be a literal answer)', () => {
    assert.equal(flagged('record(err); return null;'), 0);
  });

  test('2 literal statements are pass-shaped', () => {
    assert.equal(flagged("ok = false; return '';"), 1);
  });

  test('a rethrow or a typed-evidence return is not flagged', () => {
    assert.equal(flagged('throw err;'), 0);
    assert.equal(flagged('return evidenceFromError(err, "span");'), 0);
    assert.equal(flagged('return { kind: "unreadable", reason: String(err) };'), 0);
  });
});

describe('lint-gate-evidence-drift — property: only literal-only catches are flagged', () => {
  const literalStatement = fc.constantFrom('return true;', 'return false;', 'return null;', "return '';", 'return [];', 'return {};', 'return undefined;', 'ok = false;', 'value = null;');
  const callStatement = fc.constantFrom('record(err);', 'return evidenceFromError(err, "s");', 'throw err;', 'unreadable.push(String(err));');

  test('a catch of literal statements only is always flagged (seeded)', () => {
    fc.assert(
      fc.property(fc.array(literalStatement, { minLength: 1, maxLength: 6 }), (body) => {
        const violations = scan(`function f() { try { a(); } catch (err) { ${body.join(' ')} } }`, 'gate');
        return violations.length === 1 && violations[0].rule === RULES.PASS_SHAPED_CATCH;
      }),
      { seed: 5170, numRuns: 100 },
    );
  });

  test('a catch holding at least one non-literal statement is never flagged (seeded)', () => {
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
    const result = scanRepo(scratchRoot({ 'other.cts': 'export const x = 1;\n' }), parser);
    assert.deepEqual(result.violations, []);
    assert.equal(result.problems.length, 2);
  });

  test('a gate host the parser cannot read fails the scan instead of being skipped', () => {
    const dir = scratchRoot({ 'gate-broken.cts': 'export const = ;\n' });
    assert.throws(() => scanRepo(dir, parser));
  });

  test('a gate host with an empty catch, in a scratch tree, is reported with its file and line', () => {
    const dir = scratchRoot({
      'gate-fixture.cts': 'export function f() {\n  try { a(); } catch {}\n}\n',
      'verb-fixture.cts': "import { declareGateExit } from './gate-exit.cjs';\nexport function cmd() { declareGateExit({ outcome: 'pass' }, 'status'); }\n",
    });
    const result = scanRepo(dir, parser);
    assert.deepEqual(result.violations, [{ file: 'src/gate-fixture.cts', rule: RULES.EMPTY_CATCH, line: 2 }]);
    assert.deepEqual(result.verbHosts, ['src/verb-fixture.cts']);
  });
});

describe('lint-gate-evidence-drift — census over the real tree (matrix row 37)', () => {
  test('the allowlist is empty: the guard tolerates no site', () => {
    assert.ok(Array.isArray(ALLOWLIST) && Object.isFrozen(ALLOWLIST));
    assert.equal(ALLOWLIST.length, 0);
  });

  test('the census is zero in every class, over a non-trivial set of hosts', () => {
    const counts = census(ROOT, parser);
    assert.deepEqual(counts.problems, []);
    assert.ok(counts.gateHosts > 15, `expected the gate modules to be scanned, saw ${counts.gateHosts}`);
    assert.ok(counts.verbHosts >= 3, `expected the gate verb hosts (router, phase, verify), saw ${counts.verbHosts}`);
    assert.equal(counts.emptyCatches, 0);
    assert.equal(counts.passShapedCatches, 0);
    assert.equal(counts.readIfExists, 0);
    assert.equal(counts.verbOwnsExit, 0);
    assert.equal(counts.unreadableArmPasses, 0);
    assert.equal(counts.verbCatchNoExit, 0);
    assert.equal(counts.total, 0);
  });

  test('the verb hosts are discovered from the gate-exit importers, and include the three known consumers', () => {
    const { verbHosts } = scanRepo(ROOT, parser);
    for (const file of ['src/check-command-router.cts', 'src/phase.cts', 'src/verify.cts']) {
      assert.ok(verbHosts.includes(file), `${file} imports the exit seam and must be scanned as a verb host`);
    }
  });
});
