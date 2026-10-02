'use strict';

/**
 * #4031 (Phase 8 of epic #5056): run-tests.cjs must not report a smaller count
 * and exit 0 when tests that registered never reached the report.
 *
 * `--test-force-exit` (the Windows post-test hang backstop, #1051/#869) can end
 * the `node --test` parent while part of a test file's results is unread on the
 * child's pipe (nodejs/node#64833). The count of REGISTERED tests therefore
 * comes from the child (scripts/lib/registration-ledger-preload.cjs, `--require`d
 * into each test-file child) and is compared per file with the leaf results the
 * ndjson reporter received (analyzeChunkAccounting).
 *
 * Layers pinned here:
 *   1. analyzeChunkAccounting — pure comparison, boundary + property.
 *   2. the ledger preload — counts the registrations a real test file makes.
 *   3. the ndjson reporter — records `kind` so suites are not counted as tests.
 *   4. the whole runner — a chunk with an unaccounted test fails loudly naming
 *      the chunk and the counts; an accounted chunk still exits 0.
 *
 * Reads no source module as text; no allow-test-rule site.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { analyzeChunkAccounting, formatAccountingFailure, formatAccountingUnavailable } = require('../scripts/run-tests.cjs');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'scripts', 'run-tests.cjs');
const PRELOAD = path.join(ROOT, 'scripts', 'lib', 'registration-ledger-preload.cjs');
const REPORTER = path.join(ROOT, 'scripts', 'lib', 'ndjson-reporter.cjs');

function ndjson(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** Events file + ledger on disk for one synthetic chunk. */
function chunkFiles(t, { events, ledger }) {
  const dir = createTempDir('gsd-4031-accounting-');
  t.after(() => cleanup(dir));
  const eventsPath = path.join(dir, 'chunk-000.ndjson');
  const ledgerPath = path.join(dir, 'chunk-000.ledger.ndjson');
  if (events !== null) fs.writeFileSync(eventsPath, typeof events === 'string' ? events : ndjson(events));
  if (ledger !== null) fs.writeFileSync(ledgerPath, typeof ledger === 'string' ? ledger : ndjson(ledger));
  return { dir, eventsPath, ledgerPath };
}

const results = (file, n, type = 'test:pass', extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ type, file, name: `t${i}`, nesting: 0, testNumber: i + 1, ...extra }));

describe('analyzeChunkAccounting (#4031)', () => {
  const FILE = path.join(path.sep, 'repo', 'tests', 'a.test.cjs');

  // limit-1 / limit / limit+1 around registered = 5.
  for (const [reported, shortfall] of [[4, true], [5, false], [6, false]]) {
    test(`registered 5, reported ${reported} ${shortfall ? 'is a shortfall' : 'is accounted'}`, (t) => {
      const { eventsPath, ledgerPath } = chunkFiles(t, {
        events: results(FILE, reported),
        ledger: [{ type: 'registered', file: FILE, count: 5 }],
      });
      const a = analyzeChunkAccounting(eventsPath, ledgerPath);
      assert.equal(a.available, true);
      assert.equal(a.shortfalls.length, shortfall ? 1 : 0);
      if (shortfall) assert.deepEqual(a.shortfalls[0], { file: FILE, registered: 5, reported: 4 });
    });
  }

  test('property: a file is short exactly when reported < registered', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 40 }), (registered, reported) => {
        const dir = createTempDir('gsd-4031-prop-');
        try {
          const eventsPath = path.join(dir, 'e.ndjson');
          const ledgerPath = path.join(dir, 'l.ndjson');
          fs.writeFileSync(eventsPath, ndjson([
            { type: 'reporter:init', ts: 1 },
            ...results(FILE, reported),
          ]));
          fs.writeFileSync(ledgerPath, ndjson([{ type: 'registered', file: FILE, count: registered }]));
          const a = analyzeChunkAccounting(eventsPath, ledgerPath);
          return (a.shortfalls.length === 1) === (reported < registered)
            && a.reportedTotal === Math.min(reported, registered)
            && a.registeredTotal === registered;
        } finally {
          cleanup(dir);
        }
      }),
      { seed: 4031, numRuns: 100 },
    );
  });

  test('failures count as reported: a failing test is accounted for, not dropped', (t) => {
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: [...results(FILE, 3), ...results(FILE, 2, 'test:fail')],
      ledger: [{ type: 'registered', file: FILE, count: 5 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, []);
  });

  test('suite events are not tests: suites do not make up for a dropped test', (t) => {
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: [...results(FILE, 2), ...results(FILE, 3, 'test:pass', { kind: 'suite' })],
      ledger: [{ type: 'registered', file: FILE, count: 3 }],
    });
    const a = analyzeChunkAccounting(eventsPath, ledgerPath);
    assert.equal(a.shortfalls.length, 1);
    assert.equal(a.shortfalls[0].reported, 2);
  });

  test('run-time subtests (reported, never registered) cannot mask a loss in ANOTHER file', (t) => {
    const A = path.join(path.sep, 'repo', 'tests', 'a.test.cjs');
    const B = path.join(path.sep, 'repo', 'tests', 'b.test.cjs');
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: [...results(A, 50), ...results(B, 1)],
      ledger: [
        { type: 'registered', file: A, count: 2 },
        { type: 'registered', file: B, count: 3 },
      ],
    });
    const a = analyzeChunkAccounting(eventsPath, ledgerPath);
    assert.deepEqual(a.shortfalls, [{ file: B, registered: 3, reported: 1 }]);
  });

  test('a file that registered tests and reported none is named', (t) => {
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: [{ type: 'reporter:init', ts: 1 }],
      ledger: [{ type: 'registered', file: FILE, count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, [
      { file: FILE, registered: 2, reported: 0 },
    ]);
  });

  test('a relative path in the ledger matches the absolute path in the events', (t) => {
    const abs = path.resolve('some-dir', 'x.test.cjs');
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: results(abs, 2),
      ledger: [{ type: 'registered', file: path.join('some-dir', 'x.test.cjs'), count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, []);
  });

  test('a path spelling the two sides disagree on is the same file when it resolves to one real path (realpath on both sides)', (t) => {
    const dir = createTempDir('gsd-5170-realpath-');
    t.after(() => cleanup(dir));
    const realDir = path.join(dir, 'real');
    const aliasDir = path.join(dir, 'alias');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'x.test.cjs'), '');
    try {
      fs.symlinkSync(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a directory symlink here: ${err.code}`);
      return;
    }
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: results(path.join(realDir, 'x.test.cjs'), 2),
      ledger: [{ type: 'registered', file: path.join(aliasDir, 'x.test.cjs'), count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, []);
  });

  test('there is no basename fallback: results are never credited to a same-named file in another directory (#5170)', (t) => {
    // tests/a/x.test.cjs registered 2 and reported nothing; tests/b/x.test.cjs reported 2. Before, the lone
    // same-basename reported file was credited to a/x, hiding a/x's loss.
    const registeredAs = path.join(path.sep, 'repo', 'tests', 'a', 'x.test.cjs');
    const reportedAs = path.join(path.sep, 'repo', 'tests', 'b', 'x.test.cjs');
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: results(reportedAs, 2),
      ledger: [{ type: 'registered', file: registeredAs, count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, [
      { file: registeredAs, registered: 2, reported: 0 },
    ]);
    // Both registered: each file is judged on its own real path.
    const both = chunkFiles(t, {
      events: [...results(registeredAs, 2), ...results(reportedAs, 1)],
      ledger: [
        { type: 'registered', file: registeredAs, count: 2 },
        { type: 'registered', file: reportedAs, count: 2 },
      ],
    });
    assert.deepEqual(analyzeChunkAccounting(both.eventsPath, both.ledgerPath).shortfalls, [
      { file: reportedAs, registered: 2, reported: 1 },
    ]);
  });

  test('a missing ledger or events file is UNAVAILABLE, never read as accounted-for or as a loss', (t) => {
    const noLedger = chunkFiles(t, { events: results(FILE, 1), ledger: null });
    const a1 = analyzeChunkAccounting(noLedger.eventsPath, noLedger.ledgerPath);
    assert.equal(a1.available, false);
    assert.equal(a1.ledgerRead, false);
    assert.equal(a1.eventsRead, true);
    assert.deepEqual(a1.shortfalls, []);
    const noEvents = chunkFiles(t, { events: null, ledger: [{ type: 'registered', file: FILE, count: 1 }] });
    const a2 = analyzeChunkAccounting(noEvents.eventsPath, noEvents.ledgerPath);
    assert.equal(a2.available, false);
    assert.equal(a2.eventsRead, false);
    assert.equal(a2.ledgerRead, true);
    const noLines = chunkFiles(t, { events: results(FILE, 1), ledger: [{ type: 'other' }] });
    const a3 = analyzeChunkAccounting(noLines.eventsPath, noLines.ledgerPath);
    assert.equal(a3.available, false);
    assert.equal(a3.sawRegisteredLine, false);
  });

  test('unreadable accounting evidence is a failure message that names the chunk and which input was missing (#5170)', (t) => {
    const noLedger = chunkFiles(t, { events: results(FILE, 1), ledger: null });
    const m1 = formatAccountingUnavailable(3, 9, analyzeChunkAccounting(noLedger.eventsPath, noLedger.ledgerPath));
    assert.match(m1, /chunk 3\/9 FAILED test accounting/);
    assert.match(m1, /unreadable evidence/);
    assert.match(m1, /registration ledger could not be read/);
    assert.ok(!/events file/.test(m1), 'only the missing input is named');
    const noEvents = chunkFiles(t, { events: null, ledger: [{ type: 'registered', file: FILE, count: 1 }] });
    const m2 = formatAccountingUnavailable(1, 1, analyzeChunkAccounting(noEvents.eventsPath, noEvents.ledgerPath));
    assert.match(m2, /reporter events file could not be read/);
    const noLines = chunkFiles(t, { events: results(FILE, 1), ledger: [{ type: 'other' }] });
    const m3 = formatAccountingUnavailable(1, 1, analyzeChunkAccounting(noLines.eventsPath, noLines.ledgerPath));
    assert.match(m3, /holds no registration/);
  });

  test('a truncated trailing line is skipped, as in analyzeChunkEvents', (t) => {
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: ndjson(results(FILE, 2)) + '{"type":"test:pass","file":"',
      ledger: ndjson([{ type: 'registered', file: FILE, count: 2 }]) + '{"type":"regis',
    });
    const a = analyzeChunkAccounting(eventsPath, ledgerPath);
    assert.equal(a.available, true);
    assert.deepEqual(a.shortfalls, []);
  });

  test('the failure message names the chunk, the file and the counts', (t) => {
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: results(FILE, 1),
      ledger: [{ type: 'registered', file: FILE, count: 4 }],
    });
    const msg = formatAccountingFailure(2, 7, analyzeChunkAccounting(eventsPath, ledgerPath));
    assert.match(msg, /chunk 2\/7 FAILED test accounting/);
    assert.match(msg, /4 tests registered, 1 reported \(3 unaccounted\)/);
    assert.match(msg, /a\.test\.cjs: 4 registered, 1 reported/);
  });
});

describe('registration-ledger-preload preload (#4031)', () => {
  // Leaf results the child hands to its reporter: test + it + skip + todo + the describe-body it and
  // test + the run-time subtest of f + the direct call + the .test property = 9. A suite is not a leaf
  // and the body of a skipped suite emits nothing.
  const FIXTURE = `'use strict';
const nt = require('node:test');
const { test, describe, it } = nt;
test('a', () => {});
it('b', () => {});
test.skip('c', () => {});
it.todo('d');
describe('s', () => { it('e', () => {}); test('f', (t) => t.test('sub', () => {})); });
describe.skip('sk', () => { it('never', () => {}); });
nt('direct', () => {});
nt.test('viaprop', () => {});
`;

  function runWithPreload(t, { context, ledger }) {
    const dir = createTempDir('gsd-4031-preload-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'fx.test.cjs');
    fs.writeFileSync(file, FIXTURE);
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.GSD_RUN_TESTS_LEDGER_FILE;
    if (context) env.NODE_TEST_CONTEXT = context;
    if (ledger) env.GSD_RUN_TESTS_LEDGER_FILE = ledgerPath;
    const r = spawnSync(process.execPath, ['--require', PRELOAD, file], {
      env, cwd: dir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
    });
    return { r, file, ledgerPath };
  }

  test('inside a test-file child it counts every leaf result the child reports, keyed by the file each carries', (t) => {
    const { r, file, ledgerPath } = runWithPreload(t, { context: 'child-v8', ledger: true });
    assert.equal(r.status, 0, r.stderr);
    const lines = splitLines(fs.readFileSync(ledgerPath, 'utf8')).filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ type: 'registered', file: path.resolve(file), count: 9 }]);
  });

  test('a child that reports no result still records itself, so "saw nothing" differs from "never ran"', (t) => {
    const dir = createTempDir('gsd-5170-empty-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'empty.test.cjs');
    fs.writeFileSync(file, "'use strict';\nrequire('node:test');\n");
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8', GSD_RUN_TESTS_LEDGER_FILE: ledgerPath };
    const r = spawnSync(process.execPath, ['--require', PRELOAD, file], { env, cwd: dir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assert.equal(r.status, 0, r.stderr);
    const lines = splitLines(fs.readFileSync(ledgerPath, 'utf8')).filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ type: 'registered', file: path.resolve(file), count: 0 }]);
  });

  // Root cause of the #5170 red run (every harness chunk "N registered, 0 reported"): an earlier preload
  // wrapped test()/it() in a Proxy, a JS frame between the test file and node:test. node:test reports the
  // CALLER's location as each event's `file`, so every result came back located in the preload itself.
  test('it adds no frame to a test() call: reported events keep the test file as their location', (t) => {
    const dir = createTempDir('gsd-5170-location-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'fx.test.cjs');
    fs.writeFileSync(file, FIXTURE);
    const shim = path.join(dir, 'install-preload.cjs');
    fs.writeFileSync(shim, `require(${JSON.stringify(PRELOAD)}).install(${JSON.stringify(path.join(dir, 'ledger.ndjson'))});\n`);
    const eventsPath = path.join(dir, 'events.ndjson');
    const clean = { ...process.env };
    delete clean.NODE_TEST_CONTEXT;
    delete clean.NODE_OPTIONS;
    const r = spawnSync(
      process.execPath,
      ['--require', shim, `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', file],
      { env: { ...clean, GSD_RUN_TESTS_EVENTS_FILE: eventsPath }, cwd: dir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS },
    );
    assert.equal(r.status, 0, r.stderr);
    const results = splitLines(fs.readFileSync(eventsPath, 'utf8')).filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.type === 'test:pass' || e.type === 'test:fail');
    assert.ok(results.length >= 9, `the fixture's results are reported (${results.length})`);
    for (const e of results) assert.equal(fs.realpathSync(e.file), fs.realpathSync(file), `${e.name} is located in the test file`);
  });

  test('resultFileOf: only a leaf pass/fail with a string file counts, suites and other events never do', () => {
    const { resultFileOf } = require('../scripts/lib/registration-ledger-preload.cjs');
    const f = '/repo/tests/a.test.cjs';
    const cases = [
      [{ type: 'test:pass', data: { file: f, details: { type: 'test' } } }, f],
      [{ type: 'test:fail', data: { file: f } }, f],
      [{ type: 'test:pass', data: { file: f, details: { type: 'suite' } } }, null],
      [{ type: 'test:start', data: { file: f } }, null],
      [{ type: 'test:pass', data: { file: undefined } }, null],
      [{ type: 'test:pass', data: null }, null],
      [{ type: 'test:pass' }, null],
      [null, null],
      ['test:pass', null],
    ];
    for (const [item, expected] of cases) assert.equal(resultFileOf(item), expected, JSON.stringify(item));
  });

  test('it is inert outside a test-file child and without a ledger path', (t) => {
    const noContext = runWithPreload(t, { context: null, ledger: true });
    assert.equal(noContext.r.status, 0, noContext.r.stderr);
    assert.equal(fs.existsSync(noContext.ledgerPath), false, 'no NODE_TEST_CONTEXT: nothing is written');
    const noLedger = runWithPreload(t, { context: 'child-v8', ledger: false });
    assert.equal(noLedger.r.status, 0, noLedger.r.stderr);
    assert.equal(fs.existsSync(noLedger.ledgerPath), false, 'no ledger path: nothing is written');
  });
});

// #5170 review: can a skipped suite, a skip/todo, or a test filter make registered > reported — a false red
// on a run that lost nothing? Each case runs a REAL test file twice with the same flags (once under the
// preload, in a test-file child's context, to get its ledger line; once under the ndjson reporter to get the
// events the runner would read) and feeds both to analyzeChunkAccounting. Both sides count the same events,
// so an excluded test (filter, skipped suite) is absent from both and needs no special case.
describe('registered > reported cannot come from a skipped suite, skip/todo, or a test filter (#5170)', () => {
  const FIXTURE = `'use strict';
const { test, describe, it } = require('node:test');
test('alpha one', () => {});
test('alpha two', () => {});
test('beta one', () => {});
test.skip('gamma skipped', () => {});
test('delta todo', { todo: true }, () => {});
describe.skip('skipped suite', () => { it('inner never registered', () => {}); });
describe('live suite', () => { it('inner one', () => {}); it('inner two', () => {}); });
`;

  /** Ledger line and events for the fixture run with `flags` (node flags before the file). */
  function observe(t, flags) {
    const dir = createTempDir('gsd-5170-filter-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'fx.test.cjs');
    fs.writeFileSync(file, FIXTURE);
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const eventsPath = path.join(dir, 'events.ndjson');
    const clean = { ...process.env };
    delete clean.NODE_TEST_CONTEXT;
    delete clean.NODE_OPTIONS;
    const ledgerRun = spawnSync(process.execPath, [...flags, '--require', PRELOAD, file], {
      env: { ...clean, NODE_TEST_CONTEXT: 'child-v8', GSD_RUN_TESTS_LEDGER_FILE: ledgerPath },
      cwd: dir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
    });
    assert.equal(ledgerRun.status, 0, ledgerRun.stderr);
    const eventsRun = spawnSync(process.execPath, [...flags, `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', file], {
      env: { ...clean, GSD_RUN_TESTS_EVENTS_FILE: eventsPath },
      cwd: dir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
    });
    assert.equal(eventsRun.status, 0, eventsRun.stderr);
    return { ledgerPath, eventsPath, file };
  }

  test('no filter: skip, todo and a skipped suite are all accounted (registered == reported, no shortfall)', (t) => {
    const { ledgerPath, eventsPath, file } = observe(t, []);
    const line = JSON.parse(splitLines(fs.readFileSync(ledgerPath, 'utf8')).filter(Boolean)[0]);
    assert.deepEqual(line, { type: 'registered', file: path.resolve(file), count: 7 });
    const a = analyzeChunkAccounting(eventsPath, ledgerPath);
    assert.equal(a.available, true);
    assert.deepEqual(a.shortfalls, []);
    assert.equal(a.registeredTotal, 7);
    assert.equal(a.reportedTotal, 7);
  });

  for (const [flag, expected] of [['--test-name-pattern=alpha', 2], ['--test-skip-pattern=alpha', 5], ['--test-only', 0]]) {
    test(`${flag}: the excluded tests emit no event on either side, so ${expected} are registered and ${expected} reported`, (t) => {
      const { ledgerPath, eventsPath, file } = observe(t, [flag]);
      const line = JSON.parse(splitLines(fs.readFileSync(ledgerPath, 'utf8')).filter(Boolean)[0]);
      assert.deepEqual(line, { type: 'registered', file: path.resolve(file), count: expected });
      const a = analyzeChunkAccounting(eventsPath, ledgerPath);
      assert.equal(a.available, true);
      assert.deepEqual(a.shortfalls, []);
      assert.equal(a.registeredTotal, expected);
      assert.equal(a.reportedTotal, expected);
    });
  }

  test('control: a result genuinely missing from the report is still a shortfall under every flag set', (t) => {
    for (const flags of [[], ['--test-name-pattern=alpha']]) {
      const { ledgerPath, eventsPath } = observe(t, flags);
      const lines = splitLines(fs.readFileSync(eventsPath, 'utf8')).filter(Boolean);
      const lastResult = lines.map((l, i) => [JSON.parse(l), i]).filter(([e]) => e.type === 'test:pass' && e.kind !== 'suite').pop()[1];
      fs.writeFileSync(eventsPath, lines.filter((_, i) => i !== lastResult).join('\n') + '\n');
      const a = analyzeChunkAccounting(eventsPath, ledgerPath);
      assert.equal(a.shortfalls.length, 1, JSON.stringify(flags));
      assert.equal(a.shortfalls[0].registered - a.shortfalls[0].reported, 1);
    }
  });
});

describe('analyzeChunkAccounting: path spellings (#5170)', () => {
  // The ledger keys by the `file` node:test stamps on each result and the runner's ndjson reporter reads that
  // same field back; both sides still go through realpath so a spelling difference is never a mismatch.
  test('win32 spellings of one file (separators, drive-letter case) are the same file; a different file is not', (t) => {
    if (process.platform !== 'win32') {
      t.skip('backslash and drive-letter case are separators/identity only on Windows');
      return;
    }
    const abs = path.resolve('some-dir', 'X.test.cjs');
    const forward = abs.replace(/\\/g, '/').replace(/^[A-Z]:/, (d) => d.toLowerCase());
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: results(forward, 2),
      ledger: [{ type: 'registered', file: abs, count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, []);
  });

  test('a dot-segment spelling resolves to the same file', (t) => {
    const abs = path.resolve('some-dir', 'x.test.cjs');
    const { eventsPath, ledgerPath } = chunkFiles(t, {
      events: results(path.join(path.dirname(abs), '..', 'some-dir', 'x.test.cjs'), 2),
      ledger: [{ type: 'registered', file: abs, count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(eventsPath, ledgerPath).shortfalls, []);
  });
});

describe('ndjson reporter records the test kind (#4031)', () => {
  test('suite and test pass events are distinguishable on disk', async (t) => {
    const dir = createTempDir('gsd-4031-reporter-');
    t.after(() => cleanup(dir));
    const eventsPath = path.join(dir, 'events.ndjson');
    const previous = process.env.GSD_RUN_TESTS_EVENTS_FILE;
    process.env.GSD_RUN_TESTS_EVENTS_FILE = eventsPath;
    try {
      const reporter = require(REPORTER);
      async function* source() {
        yield { type: 'test:pass', data: { file: '/x/a.test.cjs', name: 'a suite', nesting: 0, testNumber: 1, details: { type: 'suite' } } };
        yield { type: 'test:pass', data: { file: '/x/a.test.cjs', name: 'a test', nesting: 1, testNumber: 1, details: { type: 'test' } } };
        yield { type: 'test:fail', data: { file: '/x/a.test.cjs', name: 'bare', nesting: 0, testNumber: 2 } };
      }
      await reporter(source());
    } finally {
      if (previous === undefined) delete process.env.GSD_RUN_TESTS_EVENTS_FILE;
      else process.env.GSD_RUN_TESTS_EVENTS_FILE = previous;
    }
    const events = splitLines(fs.readFileSync(eventsPath, 'utf8')).filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.type !== 'reporter:init');
    assert.deepEqual(events.map((e) => [e.name, e.kind]), [['a suite', 'suite'], ['a test', 'test'], ['bare', undefined]]);
  });
});

describe('run-tests.cjs fails a chunk whose registered tests are unaccounted (#4031)', () => {
  function runHarness(testDir) {
    const env = { ...process.env, GSD_TEST_DIR: testDir };
    // The harness's child `node --test` refuses to run inside a node:test parent context.
    delete env.NODE_TEST_CONTEXT;
    delete env.RUN_TESTS_SHARD_RESERVE;
    delete env.GSD_RUN_TESTS_LEDGER_FILE;
    delete env.GSD_RUN_TESTS_EVENTS_FILE;
    const r = runNode([HARNESS], { cwd: ROOT, env, timeoutMs: INSTALL_TIMEOUT_MS });
    return { ...toLegacyResult(r), signal: r.signal };
  }

  // The fixture reports one passing test but records, through the ledger path
  // the runner handed its chunk, that it registered `extra` more tests: exactly
  // the shape of a result dropped between the child and the report, without
  // depending on a Node race to produce it.
  const dropFixture = (extra) => `'use strict';
const { test } = require('node:test');
test('the one that is reported', () => {});
process.on('exit', () => {
  const ledger = process.env.GSD_RUN_TESTS_LEDGER_FILE;
  if (ledger) require('fs').appendFileSync(ledger, JSON.stringify({ type: 'registered', file: process.argv[1], count: ${extra} }) + '\\n');
});
`;

  test('unaccounted tests fail loudly and name the chunk and the counts', (t) => {
    const dir = createTempDir('gsd-4031-drop-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'dropped.test.cjs'), dropFixture(4), 'utf8');
    const r = runHarness(dir);
    assert.notStrictEqual(r.status, 0, `expected a failing exit; stderr:\n${r.stderr}`);
    assert.match(r.stderr, /chunk 1\/1 FAILED test accounting/);
    assert.match(r.stderr, /5 tests registered, 1 reported \(4 unaccounted\)/);
    assert.match(r.stderr, /dropped\.test\.cjs: 5 registered, 1 reported/);
  });

  test('an accounted chunk still exits 0 with no accounting complaint', (t) => {
    const dir = createTempDir('gsd-4031-accounted-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, 'ok.test.cjs'),
      `'use strict';\nconst { test, describe, it } = require('node:test');\ntest('one', () => {});\ndescribe('s', () => { it('two', () => {}); });\n`,
      'utf8',
    );
    const r = runHarness(dir);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.ok(!/FAILED test accounting/.test(r.stderr));
    assert.ok(!/could not be accounted/.test(r.stderr), 'the ledger and the events must both have been read');
  });

  // #5170: a chunk that exited 0 whose registration ledger is gone cannot be accounted. The fixture
  // removes the ledger the runner handed its chunk after the preload has written it (the preload's exit
  // handler runs first: `--require` registers it before the test file does). A WARNING here would let a
  // chunk with dropped results read as green; it must fail, naming the missing input.
  test('a chunk whose registration ledger could not be read fails loudly (unreadable evidence)', (t) => {
    const dir = createTempDir('gsd-5170-noledger-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(
      path.join(dir, 'noledger.test.cjs'),
      `'use strict';
const { test } = require('node:test');
test('passes', () => {});
process.on('exit', () => {
  const ledger = process.env.GSD_RUN_TESTS_LEDGER_FILE;
  if (ledger) require('fs').rmSync(ledger, { force: true });
});
`,
      'utf8',
    );
    const r = runHarness(dir);
    assert.notStrictEqual(r.status, 0, `an unaccountable chunk fails; stderr:\n${r.stderr}`);
    assert.match(r.stderr, /chunk 1\/1 FAILED test accounting/);
    assert.match(r.stderr, /unreadable evidence/);
    assert.match(r.stderr, /registration ledger could not be read/);
    assert.ok(!/WARNING: chunk 1\/1 could not be accounted/.test(r.stderr), 'no longer a warning');
  });
});
