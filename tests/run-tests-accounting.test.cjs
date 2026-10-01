'use strict';

/**
 * #4031 (Phase 8 of epic #5056): run-tests.cjs must not report a smaller count
 * and exit 0 when tests that registered never reached the report.
 *
 * `--test-force-exit` (the Windows post-test hang backstop, #1051/#869) can end
 * the `node --test` parent while part of a test file's results is unread on the
 * child's pipe (nodejs/node#64833). The count of REGISTERED tests therefore
 * comes from the child (scripts/lib/test-registration-ledger.cjs, `--require`d
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
const { analyzeChunkAccounting, formatAccountingFailure } = require('../scripts/run-tests.cjs');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'scripts', 'run-tests.cjs');
const PRELOAD = path.join(ROOT, 'scripts', 'lib', 'test-registration-ledger.cjs');
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

  test('a path spelling the two sides disagree on is matched by its single unclaimed basename', (t) => {
    const registeredAs = path.join(path.sep, 'mnt', 'repo', 'tests', 'x.test.cjs');
    const reportedAs = path.join(path.sep, 'srv', 'repo', 'tests', 'x.test.cjs');
    const matched = chunkFiles(t, {
      events: results(reportedAs, 2),
      ledger: [{ type: 'registered', file: registeredAs, count: 2 }],
    });
    assert.deepEqual(analyzeChunkAccounting(matched.eventsPath, matched.ledgerPath).shortfalls, []);
    // Two same-named candidates: ambiguous, so it is NOT guessed — the shortfall stands.
    const other = path.join(path.sep, 'opt', 'repo', 'tests', 'x.test.cjs');
    const ambiguous = chunkFiles(t, {
      events: [...results(reportedAs, 2), ...results(other, 2)],
      ledger: [{ type: 'registered', file: registeredAs, count: 2 }],
    });
    assert.equal(analyzeChunkAccounting(ambiguous.eventsPath, ambiguous.ledgerPath).shortfalls.length, 1);
  });

  test('a missing ledger or events file is UNAVAILABLE, never read as accounted-for or as a loss', (t) => {
    const noLedger = chunkFiles(t, { events: results(FILE, 1), ledger: null });
    const a1 = analyzeChunkAccounting(noLedger.eventsPath, noLedger.ledgerPath);
    assert.equal(a1.available, false);
    assert.deepEqual(a1.shortfalls, []);
    const noEvents = chunkFiles(t, { events: null, ledger: [{ type: 'registered', file: FILE, count: 1 }] });
    const a2 = analyzeChunkAccounting(noEvents.eventsPath, noEvents.ledgerPath);
    assert.equal(a2.available, false);
    const noLines = chunkFiles(t, { events: results(FILE, 1), ledger: [{ type: 'other' }] });
    assert.equal(analyzeChunkAccounting(noLines.eventsPath, noLines.ledgerPath).available, false);
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

describe('test-registration-ledger preload (#4031)', () => {
  // test + it + skip + todo + describe-body it + test + direct call + .test property = 8;
  // the run-time subtest and the body of a skipped suite are not registrations.
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

  test('inside a test-file child it counts every registration the file makes', (t) => {
    const { r, file, ledgerPath } = runWithPreload(t, { context: 'child-v8', ledger: true });
    assert.equal(r.status, 0, r.stderr);
    const lines = splitLines(fs.readFileSync(ledgerPath, 'utf8')).filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ type: 'registered', file: path.resolve(file), count: 8 }]);
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
});
