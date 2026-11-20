'use strict';

/**
 * run-static-checks.test.cjs: behavior of scripts/run-static-checks.cjs
 * (ADR-6315 item 19, #6414). The runner loads checks as modules and reports
 * every finding in one run; these cases use stub checks in a temporary
 * directory, so they test the runner and not any real check.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { loadChecks, runChecks, formatReport, main } = require('../scripts/run-static-checks.cjs');

function checksDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-static-checks-'));
  t.after(() => cleanup(dir));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const stub = (name, body) => `module.exports = { name: ${JSON.stringify(name)}, run: ${body} };\n`;

describe('loadChecks', () => {
  test('loads every .cjs module in name order and ignores other files', (t) => {
    const dir = checksDir(t, {
      'b.cjs': stub('b', '() => []'),
      'a.cjs': stub('a', '() => []'),
      'notes.md': 'not a check',
    });
    assert.deepEqual(loadChecks(dir).map((c) => c.name), ['a', 'b']);
  });

  test('a module without name and run is rejected, naming the file', (t) => {
    const dir = checksDir(t, { 'bad.cjs': 'module.exports = { name: "bad" };\n' });
    assert.throws(() => loadChecks(dir), /bad\.cjs must export/);
  });

  test('the real checks directory loads and every check has a unique name', () => {
    const names = loadChecks().map((c) => c.name);
    assert.ok(names.includes('portability-rule-disable-ban'));
    assert.equal(new Set(names).size, names.length);
  });
});

describe('runChecks', () => {
  test('a failing check does not stop the checks after it', () => {
    const checks = [
      { name: 'first', run: () => [{ file: 'a', line: 1, message: 'one' }] },
      { name: 'second', run: () => [] },
      { name: 'third', run: () => [{ file: 'c', line: 3, message: 'three' }] },
    ];
    const results = runChecks(checks, { root: os.tmpdir() });
    assert.deepEqual(results.map((r) => r.findings.length), [1, 0, 1]);
  });

  test('a check that throws is one finding, and the others still run', () => {
    const checks = [
      { name: 'boom', run: () => { throw new Error('exploded'); } },
      { name: 'fine', run: () => [] },
    ];
    const results = runChecks(checks, { root: os.tmpdir() });
    assert.equal(results[0].findings.length, 1);
    assert.match(results[0].findings[0].message, /the check threw: exploded/);
    assert.equal(results[1].findings.length, 0);
  });

  test('each check receives the root', () => {
    let seen = null;
    runChecks([{ name: 'c', run: ({ root }) => { seen = root; return []; } }], { root: '/some/root' });
    assert.equal(seen, '/some/root');
  });
});

describe('loadChecks and runChecks: a broken check never hides the others', () => {
  test('a module that throws when loaded becomes a finding naming the file', (t) => {
    const dir = checksDir(t, {
      'a-broken.cjs': 'throw new Error("syntax went away");\n',
      'b-fine.cjs': stub('b-fine', '() => []'),
    });
    const results = runChecks(loadChecks(dir), { root: os.tmpdir() });
    assert.equal(results.length, 2);
    assert.equal(results[0].findings.length, 1);
    assert.equal(results[0].findings[0].file, 'a-broken.cjs');
    assert.match(results[0].findings[0].message, /could not load: syntax went away/);
    assert.deepEqual(results[1].findings, []);
  });

  test('a check whose run returns a non-array is one finding, not a crash in the report', () => {
    const results = runChecks([{ name: 'bad', run: () => 'nope' }], { root: os.tmpdir() });
    assert.equal(results[0].findings.length, 1);
    assert.match(results[0].findings[0].message, /must return an array/);
    assert.doesNotThrow(() => formatReport(results));
  });
});

describe('main', () => {
  const sink = () => {
    const chunks = [];
    return { write: (text) => chunks.push(text), text: () => chunks.join('') };
  };
  const run = (t, files, argv) => {
    const dir = checksDir(t, files);
    const stdout = sink();
    const stderr = sink();
    const code = main(argv, { dir, root: os.tmpdir(), stdout, stderr });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  const green = stub('green', '() => []');
  const red = stub('red', '() => [{ file: "f", line: 2, message: "bad" }]');

  test('all green exits 0 and reports on stdout', (t) => {
    const out = run(t, { 'green.cjs': green }, []);
    assert.equal(out.code, 0);
    assert.equal(out.stdout, 'static checks: 1 passed\n');
    assert.equal(out.stderr, '');
  });

  test('a finding exits 1 and reports on stderr, with every check run', (t) => {
    const out = run(t, { 'a-red.cjs': red, 'b-green.cjs': green }, []);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /^red: f:2: bad\n/);
    assert.equal(out.stdout, '');
  });

  test('--only runs just the named check', (t) => {
    const out = run(t, { 'a-red.cjs': red, 'b-green.cjs': green }, ['--only', 'green']);
    assert.equal(out.code, 0);
    assert.equal(out.stdout, 'static checks: 1 passed\n');
  });

  test('an unknown check name exits 2 and names it', (t) => {
    const out = run(t, { 'green.cjs': green }, ['--only', 'missing']);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /unknown check\(s\): missing/);
  });

  test('--only with no name exits 2 instead of running everything', (t) => {
    const out = run(t, { 'a-red.cjs': red }, ['--only']);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /--only needs a check name/);
  });

  test('a directory with no checks exits 1 instead of passing everything', (t) => {
    const out = run(t, { 'notes.md': 'no checks here' }, []);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /no checks found/);
    assert.equal(out.stdout, '');
  });

  test('a malformed finding is one finding of the check, not a crash in the report', () => {
    for (const bad of [[null], [{}], [{ message: 5 }], ['text']]) {
      const results = runChecks([{ name: 'bad', run: () => bad }], { root: os.tmpdir() });
      assert.equal(results[0].findings.length, 1, JSON.stringify(bad));
      assert.match(results[0].findings[0].message, /must be an object with a string message/);
      assert.doesNotThrow(() => formatReport(results));
    }
  });

  test('an unknown argument exits 2', (t) => {
    const out = run(t, { 'green.cjs': green }, ['--bogus']);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /unknown argument: --bogus/);
  });
});

describe('formatReport', () => {
  test('lists every finding as name: file:line: message, then the count', () => {
    const report = formatReport([
      { name: 'x', findings: [{ file: 'f.cjs', line: 4, message: 'bad' }] },
      { name: 'y', findings: [] },
    ]);
    assert.equal(report, 'x: f.cjs:4: bad\nstatic checks: 1 finding(s) in 1 of 2 check(s)');
  });

  test('all green reports the number of checks that passed', () => {
    assert.equal(formatReport([{ name: 'x', findings: [] }]), 'static checks: 1 passed');
  });
});
