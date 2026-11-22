'use strict';

/**
 * fold-helper-shadowing.test.cjs
 *
 * Detection cases for scripts/static-checks/fold-helper-shadowing.cjs (#4409).
 * The scan of the real tests/ tree is no longer a test: it runs once in
 * scripts/run-static-checks.cjs (ADR-6315 item 19, #6434). These cases run the
 * check on small temporary trees, so each fails when the check stops detecting
 * what it exists to detect.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const check = require('../scripts/static-checks/fold-helper-shadowing.cjs');

const SUBJECT = 'subject.test.cjs';
const CLEAN_SUBJECT = "function extractShellBlocks(content) {\n  return content.split(/\\r?\\n/);\n}\n";

/** A repository root whose tests/ holds the given files. */
function makeRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fold-shadow-'));
  t.after(() => cleanup(root));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, 'tests', ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const run = (root, extra = {}) => check.run({ root, subject: SUBJECT, known: [], minFiles: 0, ...extra });

const shadowed = (name) => `function ${name}() { return 1; }\n{\n  function ${name}() { return 2; }\n}\n`;

describe('foldShadowedIn', () => {
  test('a function re-declared inside a program-level block is a shadow, at both lines', (t) => {
    const root = makeRoot(t, { 'a.test.cjs': shadowed('helper') });
    const shadows = check.foldShadowedIn(path.join(root, 'tests'), 'a.test.cjs');
    assert.equal(shadows.length, 1);
    assert.equal(shadows[0].key, 'a.test.cjs::helper');
    assert.equal(shadows[0].moduleLine, 1);
    assert.equal(shadows[0].foldLine, 3);
  });

  test('an arrow-form helper shadows the same way', (t) => {
    const root = makeRoot(t, { 'a.test.cjs': 'const helper = () => 1;\n{\n  const helper = () => 2;\n}\n' });
    assert.equal(check.foldShadowedIn(path.join(root, 'tests'), 'a.test.cjs').length, 1);
  });

  test('a helper re-declared deep inside the fold (in the callback of a describe) is a shadow', (t) => {
    const root = makeRoot(t, {
      'a.test.cjs': "function helper() {}\n{\n  describe('x', () => {\n    function helper() {}\n  });\n}\n",
    });
    const shadows = check.foldShadowedIn(path.join(root, 'tests'), 'a.test.cjs');
    assert.equal(shadows.length, 1);
    assert.equal(shadows[0].foldLine, 4);
  });

  test('a helper declared once, a different name inside the fold, and a nested non-fold function are not shadows', (t) => {
    const root = makeRoot(t, {
      'a.test.cjs': 'function helper() {}\n{\n  function other() {}\n}\n',
      'b.test.cjs': 'function helper() {}\nfunction outer() {\n  function helper() {}\n}\n',
    });
    const dir = path.join(root, 'tests');
    assert.deepEqual(check.foldShadowedIn(dir, 'a.test.cjs'), []);
    assert.deepEqual(check.foldShadowedIn(dir, 'b.test.cjs'), []);
  });
});

describe('run: the three findings', () => {
  test('a clean subject and an empty baseline report nothing', (t) => {
    assert.deepEqual(run(makeRoot(t, { [SUBJECT]: CLEAN_SUBJECT })), []);
  });

  test('the default minimum is 901 files (the old test required more than 900)', () => {
    assert.equal(check.MIN_FILES, 901);
  });

  test('a shadow in the subject is reported at its fold line', (t) => {
    // The fixture's own extractShellBlocks is renamed so only the shadow finding is under test.
    const findings = run(makeRoot(t, { [SUBJECT]: shadowed('extractShellBlocks') + CLEAN_SUBJECT.replace('function extractShellBlocks', 'function unused') }));
    const subjectFindings = findings.filter((f) => f.file === `tests/${SUBJECT}` && /re-declared inside a fold/.test(f.message));
    assert.equal(subjectFindings.length, 1);
    assert.equal(subjectFindings[0].line, 3);
  });

  test('a new shadow elsewhere is reported and names the file and helper', (t) => {
    const findings = run(makeRoot(t, { [SUBJECT]: CLEAN_SUBJECT, 'other.test.cjs': shadowed('helper') }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'tests/other.test.cjs');
    assert.match(findings[0].message, /other\.test\.cjs::helper is a new fold-shadowed helper/);
  });

  test('a baseline entry that is no longer shadowed is a finding (the baseline only shrinks)', (t) => {
    const findings = run(makeRoot(t, { [SUBJECT]: CLEAN_SUBJECT }), { known: ['gone.test.cjs::helper'] });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /gone\.test\.cjs::helper is in KNOWN_FOLD_SHADOWS but no longer shadowed/);
  });

  test('a baselined shadow is accepted, and a duplicate pair needs both entries', (t) => {
    const root = makeRoot(t, { [SUBJECT]: CLEAN_SUBJECT, 'other.test.cjs': shadowed('helper') });
    assert.deepEqual(run(root, { known: ['other.test.cjs::helper'] }), []);
    const twice = makeRoot(t, {
      [SUBJECT]: CLEAN_SUBJECT,
      'other.test.cjs': 'function helper() {}\n{\n  function helper() {}\n  function helper() {}\n}\n',
    });
    assert.equal(run(twice, { known: ['other.test.cjs::helper'] }).length, 1);
    assert.deepEqual(run(twice, { known: ['other.test.cjs::helper', 'other.test.cjs::helper'] }), []);
  });

  test('a corpus smaller than the minimum is a finding: exactly the minimum passes, one more required fails', (t) => {
    const root = makeRoot(t, { [SUBJECT]: CLEAN_SUBJECT, 'a.test.cjs': 'const x = 1;\n' });
    assert.deepEqual(run(root, { minFiles: 2 }), []);
    const findings = run(root, { minFiles: 3 });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /expected the full corpus \(at least 3 files\), scanned 2/);
  });

  test('a missing subject file is a finding', (t) => {
    const findings = run(makeRoot(t, { 'a.test.cjs': 'const x = 1;\n' }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /subject file of the fold-shadow check is missing/);
  });

  test('a file that does not parse is a finding, not a skip', (t) => {
    const findings = run(makeRoot(t, { [SUBJECT]: CLEAN_SUBJECT, 'broken.test.cjs': 'const = ;\n' }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /the corpus scan failed/);
  });
});

describe('extractShellBlocks splits lines CRLF-safely', () => {
  const problems = (t, text) => check.extractShellBlocksProblems(path.join(makeRoot(t, { [SUBJECT]: text }), 'tests'), SUBJECT);

  test('a split on /\\r?\\n/ is clean', (t) => {
    assert.deepEqual(problems(t, CLEAN_SUBJECT), []);
  });

  test('a split on a bare "\\n" is reported', (t) => {
    const out = problems(t, "function extractShellBlocks(content) {\n  return content.split('\\n');\n}\n");
    assert.equal(out.length, 1);
    assert.match(out[0], /a bare "\\n" leaves a trailing \\r/);
  });

  test('a regex split that tolerates no carriage return is reported', (t) => {
    assert.equal(problems(t, 'function extractShellBlocks(content) {\n  return content.split(/\\n/);\n}\n').length, 1);
  });

  test('a function that never splits its parameter is reported', (t) => {
    const out = problems(t, 'function extractShellBlocks(content) {\n  return [content];\n}\n');
    assert.match(out[0], /must split its "content" parameter into lines/);
  });

  test('two declarations, or none, are reported', (t) => {
    assert.match(problems(t, CLEAN_SUBJECT + CLEAN_SUBJECT)[0], /exactly one extractShellBlocks/);
    assert.match(problems(t, 'const x = 1;\n')[0], /exactly one extractShellBlocks/);
  });
});
