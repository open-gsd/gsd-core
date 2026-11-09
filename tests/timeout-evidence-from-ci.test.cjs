'use strict';

/**
 * Behavioral suite for scripts/timeout-evidence-from-ci.cjs (#4689), the script that reproduces the
 * CI figures in tests/helpers/timeouts.cjs TIMEOUT_EVIDENCE. Every input is synthetic: source
 * strings fed through an in-memory view, and records written as jsonl text. The CLASS_*_MS names
 * below are neutral test data standing in for timeouts.cjs exports. No wall-clock values are
 * asserted and no repository source is read.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const script = require('../scripts/timeout-evidence-from-ci.cjs');

const SEAM_IMPORT = "const { runNode, runGit } = require('./helpers/process-seam.cjs');\n";

// Synthetic bound values carried by the records and held by the CLASS_*_MS stand-ins.
const BOUND_SMALL = 15000;
const BOUND_SMALL_PLUS_ONE = BOUND_SMALL + 1;
const BOUND_SHARED = 60000;
const BOUND_LARGE = 120000;

/** In-memory stand-in for the repository view: files is a { rel: source } map. */
function viewOf(files) {
  return {
    read: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null),
    listFiles: () => Object.keys(files).sort(),
  };
}

/** One jsonl line shaped like a seam:spawn-stall record. */
function stall(overrides = {}) {
  return JSON.stringify({
    type: 'seam:spawn-stall',
    file: 'a.test.cjs',
    command: 'node',
    argv: [],
    durationMs: 3000,
    timeoutMs: BOUND_SMALL,
    startedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });
}

const lane = (os, lines, runId = '1') => script.parseLane(lines.join('\n'), { os, runId, art: 'test-timings-' + os });

const seamSite = (file, line, constants, callee = 'runNode') => ({ file, line, constants, callee, cls: 'SEAM', via: 'ast' });

function attribute(files, sites, values, lanes, historicalValues) {
  const view = viewOf(files);
  return script.attributeRecords(lanes, { sites, values, index: script.createRepoIndex(view), historicalValues });
}

describe('census and classification', () => {
  const NAMES = ['CLASS_A_MS', 'CLASS_E_MS'];

  function sitesOf(files) {
    const view = viewOf(files);
    const census = script.censusRepo(view, NAMES);
    return script.buildSites(census, script.createClassifier(view), []);
  }

  test('a call routed through the process seam is a seam site, a direct child_process call is a raw site', () => {
    const { sites, unresolvedSites } = sitesOf({
      'tests/seam.test.cjs': SEAM_IMPORT + "runNode(['x.js'], { timeoutMs: CLASS_A_MS });\n",
      'tests/raw.test.cjs': "const cp = require('node:child_process');\ncp.execFileSync('git', [], { timeout: CLASS_E_MS });\n",
    });
    const byFile = Object.fromEntries(sites.map((s) => [s.file, s]));
    assert.equal(byFile['tests/seam.test.cjs'].cls, 'SEAM');
    assert.deepEqual(byFile['tests/seam.test.cjs'].constants, ['CLASS_A_MS']);
    assert.equal(byFile['tests/raw.test.cjs'].cls, 'DIRECT');
    assert.equal(byFile['tests/raw.test.cjs'].line, 2);
    assert.deepEqual(unresolvedSites, []);
  });

  test('a seam wrapper defined in a required helper classifies the caller as seam', () => {
    const { sites } = sitesOf({
      'tests/helpers/wrap.cjs': SEAM_IMPORT + 'function wrapped(a, o) { return runNode(a, o); }\nmodule.exports = { wrapped };\n',
      'tests/use.test.cjs': "const { wrapped } = require('./helpers/wrap.cjs');\nwrapped([], { timeoutMs: CLASS_A_MS });\n",
    });
    assert.equal(sites.find((s) => s.file === 'tests/use.test.cjs').cls, 'SEAM');
  });

  test('a node:test runner option and a file-local redefinition are dropped, not counted', () => {
    const { sites, dropped } = sitesOf({
      'tests/runner.test.cjs': "test('x', { timeout: CLASS_A_MS }, () => {});\n",
      'tests/local.test.cjs': "const CLASS_A_MS = 5;\nconst cp = require('child_process');\ncp.spawnSync('x', [], { timeout: CLASS_A_MS });\n",
    });
    assert.deepEqual(sites, []);
    assert.deepEqual(dropped.map((d) => d.file).sort(), ['tests/local.test.cjs', 'tests/runner.test.cjs']);
    assert.match(dropped.find((d) => d.file === 'tests/local.test.cjs').why, /redefinition at line 1/);
  });

  test('a required constant (destructured from require) is not a redefinition', () => {
    const r = script.censusSource("const { CLASS_A_MS } = require('./helpers/timeouts.cjs');\nrun({ timeout: CLASS_A_MS });\n", 'tests/x.test.cjs', NAMES);
    assert.deepEqual(r.localRedefs, []);
    assert.equal(r.propRows.length, 1);
  });

  test('a file that does not parse is reported, not thrown', () => {
    const r = script.censusSource('const = ;', 'tests/bad.test.cjs', NAMES);
    assert.equal(typeof r.parseError, 'string');
    assert.deepEqual(r.propRows, []);
  });

  test('a manual resolution replaces an unresolved result and an unmatched resolution is reported', () => {
    const files = { 'tests/x.test.cjs': 'const opts = { timeout: CLASS_A_MS };\nsomething(opts);\n' };
    const view = viewOf(files);
    const census = script.censusRepo(view, NAMES);
    const classifier = script.createClassifier(view);
    const unresolved = script.buildSites(census, classifier, []);
    assert.equal(unresolved.sites[0].cls, 'UNCLASSIFIED');
    assert.equal(unresolved.unresolvedSites.length, 1);
    const resolutions = [
      { file: 'tests/x.test.cjs', callee: '(not-direct-arg) var=opts', cls: 'SEAM', resolvedCallee: 'runNode', note: 'n' },
      { file: 'tests/gone.test.cjs', callee: 'run', cls: 'SEAM', resolvedCallee: 'run', note: 'n' },
    ];
    const resolved = script.buildSites(census, classifier, resolutions);
    assert.equal(resolved.sites[0].cls, 'SEAM');
    assert.deepEqual(resolved.unresolvedSites, []);
    assert.deepEqual(resolved.unusedResolutions.map((o) => o.file), ['tests/gone.test.cjs']);
  });

  test('constantsFromTimeouts keeps measured, mirror and backstop names and drops fixture data', () => {
    const T = {
      CLASS_A_MS: 1, CLASS_B_MS: 2, CLASS_C_MS: 3, CLASS_D_MS: 4,
      TIMEOUT_EVIDENCE: {
        CLASS_A_MS: { kind: 'measured' },
        CLASS_B_MS: { kind: 'mirror' },
        CLASS_C_MS: { kind: 'test-backstop' },
        CLASS_D_MS: { kind: 'fixture-data' },
      },
    };
    const r = script.constantsFromTimeouts(T);
    assert.deepEqual(r.censusNames, ['CLASS_A_MS', 'CLASS_B_MS', 'CLASS_C_MS']);
    assert.deepEqual(r.evidenceNames, ['CLASS_A_MS', 'CLASS_B_MS']);
    assert.deepEqual(r.values, { CLASS_A_MS: 1, CLASS_B_MS: 2, CLASS_C_MS: 3 });
  });
});

describe('attribution', () => {
  const VALUES = { CLASS_A_MS: BOUND_SMALL, CLASS_B_MS: BOUND_SHARED, CLASS_C_MS: BOUND_SHARED, CLASS_D_MS: BOUND_LARGE };
  const FILE = 'tests/a.test.cjs';

  test('a record with a single candidate constant is credited to it', () => {
    const files = { [FILE]: SEAM_IMPORT + "runNode(['x.js'], { timeoutMs: CLASS_A_MS });\n" };
    const r = attribute(files, [seamSite(FILE, 2, ['CLASS_A_MS'])], VALUES, [lane('linux', [stall()])]);
    assert.equal(r.credited.CLASS_A_MS.length, 1);
    assert.equal(r.ambiguous.length, 0);
    assert.equal(r.unmatched.length, 0);
  });

  test('a record whose timeoutMs equals no candidate constant value is unmatched', () => {
    const files = { [FILE]: SEAM_IMPORT + "runNode(['x.js'], { timeoutMs: CLASS_A_MS });\n" };
    const r = attribute(files, [seamSite(FILE, 2, ['CLASS_A_MS'])], VALUES, [lane('linux', [stall({ timeoutMs: BOUND_SMALL_PLUS_ONE })])]);
    assert.equal(r.unmatched.length, 1);
    assert.deepEqual(r.credited, {});
  });

  test('two constants sharing a value are narrowed by command: git goes to the git site, node to the node site', () => {
    const files = {
      [FILE]: SEAM_IMPORT + "runGit(['status'], { timeoutMs: CLASS_B_MS });\nrunNode(['x.js'], { timeoutMs: CLASS_C_MS });\n",
    };
    const sites = [
      seamSite(FILE, 2, ['CLASS_B_MS'], 'runGit'),
      seamSite(FILE, 3, ['CLASS_C_MS'], 'runNode'),
    ];
    const lanes = [lane('linux', [stall({ timeoutMs: BOUND_SHARED, command: 'git' }), stall({ timeoutMs: BOUND_SHARED, command: 'node.exe' })])];
    const r = attribute(files, sites, VALUES, lanes);
    assert.equal(r.credited.CLASS_B_MS.length, 1);
    assert.equal(r.credited.CLASS_B_MS[0].command, 'git');
    assert.equal(r.credited.CLASS_C_MS.length, 1);
    assert.equal(r.credited.CLASS_C_MS[0].command, 'node.exe');
    assert.equal(r.narrowed, 2);
  });

  test('two constants sharing a value are narrowed by the site literals found in argv', () => {
    const files = {
      [FILE]: SEAM_IMPORT + "runNode(['alpha.js'], { timeoutMs: CLASS_B_MS });\nrunNode(['beta.js'], { timeoutMs: CLASS_C_MS });\n",
    };
    const sites = [seamSite(FILE, 2, ['CLASS_B_MS']), seamSite(FILE, 3, ['CLASS_C_MS'])];
    const r = attribute(files, sites, VALUES, [lane('linux', [stall({ timeoutMs: BOUND_SHARED, argv: ['/tmp/beta.js'] })])]);
    assert.equal(r.credited.CLASS_C_MS.length, 1);
    assert.equal(r.credited.CLASS_B_MS, undefined);
  });

  test('two constants that cannot be told apart are ambiguous and credited to neither', () => {
    const files = {
      [FILE]: SEAM_IMPORT + "runNode(['x.js'], { timeoutMs: CLASS_B_MS });\nrunNode(['x.js'], { timeoutMs: CLASS_C_MS });\n",
    };
    const sites = [seamSite(FILE, 2, ['CLASS_B_MS']), seamSite(FILE, 3, ['CLASS_C_MS'])];
    const r = attribute(files, sites, VALUES, [lane('linux', [stall({ timeoutMs: BOUND_SHARED, argv: ['x.js'] })])]);
    assert.deepEqual(r.credited, {});
    assert.equal(r.ambiguous.length, 1);
    assert.deepEqual(r.ambiguous[0].candidates.sort(), ['CLASS_B_MS', 'CLASS_C_MS']);
  });

  test('a record is credited through a helper the test file requires when the file has no in-file site', () => {
    const files = {
      'tests/b.test.cjs': "const h = require('./helpers/h.cjs');\n",
      'tests/helpers/h.cjs': SEAM_IMPORT + 'module.exports = () => runNode([], { timeoutMs: CLASS_A_MS });\n',
    };
    const sites = [seamSite('tests/helpers/h.cjs', 2, ['CLASS_A_MS'])];
    const r = attribute(files, sites, VALUES, [lane('linux', [stall({ file: 'b.test.cjs' })])]);
    assert.equal(r.credited.CLASS_A_MS.length, 1);
    assert.equal(r.viaHelper, 1);
    assert.equal(r.credited.CLASS_A_MS[0].viaHelper, true);
  });

  test('a helper is used when the in-file site has a different value, and ignored when the in-file site matches', () => {
    const files = {
      [FILE]: "const h = require('./helpers/h.cjs');\n" + SEAM_IMPORT + 'runNode([], { timeoutMs: CLASS_D_MS });\n',
      'tests/helpers/h.cjs': SEAM_IMPORT + 'module.exports = () => runNode([], { timeoutMs: CLASS_A_MS });\n',
    };
    const sites = [seamSite(FILE, 3, ['CLASS_D_MS']), seamSite('tests/helpers/h.cjs', 2, ['CLASS_A_MS'])];
    const lanes = [lane('linux', [stall({ timeoutMs: BOUND_SMALL }), stall({ timeoutMs: BOUND_LARGE })])];
    const r = attribute(files, sites, VALUES, lanes);
    assert.equal(r.credited.CLASS_A_MS.length, 1);
    assert.equal(r.credited.CLASS_A_MS[0].viaHelper, true);
    assert.equal(r.credited.CLASS_D_MS.length, 1);
    assert.equal(r.credited.CLASS_D_MS[0].viaHelper, undefined);
    assert.equal(r.viaHelper, 1);
  });

  test('a historical value lets records from before a constant changed reach it', () => {
    const files = { [FILE]: SEAM_IMPORT + 'runNode([], { timeoutMs: CLASS_C_MS });\n' };
    const sites = [seamSite(FILE, 2, ['CLASS_C_MS'])];
    const values = { CLASS_C_MS: BOUND_SHARED + BOUND_SMALL };
    const lanes = [lane('linux', [stall({ timeoutMs: BOUND_SHARED })])];
    assert.equal(attribute(files, sites, values, lanes).unmatched.length, 1);
    const r = attribute(files, sites, values, lanes, { CLASS_C_MS: [BOUND_SHARED] });
    assert.equal(r.credited.CLASS_C_MS.length, 1);
  });
});

describe('summary', () => {
  const ascending = (n) => Array.from({ length: n }, (_, i) => i + 1);

  test('no records: every figure is null', () => {
    assert.deepEqual(script.summarizeDurations([]), { records: 0, p50: null, p99: null, max: null });
  });

  test('one record is its own p50, p99 and max', () => {
    assert.deepEqual(script.summarizeDurations([7]), { records: 1, p50: 7, p99: 7, max: 7 });
  });

  test('two records, given unsorted: p50 is the lower, p99 and max the higher', () => {
    assert.deepEqual(script.summarizeDurations([9, 1]), { records: 2, p50: 1, p99: 9, max: 9 });
  });

  test('99, 100 and 101 records: p99 is the nearest-rank value', () => {
    assert.deepEqual(script.summarizeDurations(ascending(99)), { records: 99, p50: 50, p99: 99, max: 99 });
    assert.deepEqual(script.summarizeDurations(ascending(100)), { records: 100, p50: 50, p99: 99, max: 100 });
    assert.deepEqual(script.summarizeDurations(ascending(101)), { records: 101, p50: 51, p99: 100, max: 101 });
  });

  test('p50 <= p99 <= max for any non-empty list of durations', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1e7 }), { minLength: 1, maxLength: 300 }), (durations) => {
        const s = script.summarizeDurations(durations);
        return s.p50 <= s.p99 && s.p99 <= s.max && s.max === Math.max(...durations) && s.records === durations.length;
      }),
      { seed: 4689, numRuns: 200 },
    );
  });

  test('parseLane keeps stall records and test files, skips malformed lines, tracks the start range', () => {
    const l = script.parseLane([
      stall({ startedAt: '2026-11-02T00:00:00.000Z' }),
      '{"type":"seam:spawn-stall", broken',
      stall({ startedAt: '2026-11-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'test:summary', data: { file: '/ci/tests/a.test.cjs' } }),
      JSON.stringify({ type: 'test:summary', data: { file: 'C:\\ci\\tests\\b.test.cjs' } }),
      JSON.stringify({ type: 'other' }),
      '',
    ].join('\n'), { os: 'win32', runId: '9', art: 'x' });
    assert.equal(l.stalls.length, 2);
    assert.deepEqual([...l.files].sort(), ['a.test.cjs', 'b.test.cjs']);
    assert.equal(l.startedMin, '2026-11-01T00:00:00.000Z');
    assert.equal(l.startedMax, '2026-11-02T00:00:00.000Z');
  });

  test('artifact names map to platforms', () => {
    assert.equal(script.osOfArtifact('test-timings-ubuntu-unit-job3'), 'linux');
    assert.equal(script.osOfArtifact('test-timings-windows-latest-job1'), 'win32');
    assert.equal(script.osOfArtifact('test-timings-macos-latest-job0'), 'darwin');
    assert.equal(script.osOfArtifact('test-timings-other'), 'other');
  });

  test('lane coverage counts one per lane that ran a file of the class, directly or through a helper', () => {
    const files = {
      'tests/a.test.cjs': SEAM_IMPORT,
      'tests/b.test.cjs': "require('./helpers/h.cjs');\n",
      'tests/c.test.cjs': '',
      'tests/helpers/h.cjs': SEAM_IMPORT,
    };
    const index = script.createRepoIndex(viewOf(files));
    const sites = [seamSite('tests/a.test.cjs', 1, ['CLASS_A_MS']), seamSite('tests/helpers/h.cjs', 1, ['CLASS_A_MS'])];
    const withFiles = (os, names) => {
      const l = lane(os, []);
      names.forEach((n) => l.files.add(n));
      return l;
    };
    const lanes = [
      withFiles('win32', ['a.test.cjs', 'c.test.cjs']),
      withFiles('win32', ['b.test.cjs']),
      withFiles('win32', ['c.test.cjs']),
      withFiles('linux', ['a.test.cjs', 'b.test.cjs']),
      withFiles('darwin', []),
    ];
    assert.deepEqual(script.laneCoverage(lanes, sites, index), { win32: 2, darwin: 0, linux: 1 });
  });

  test('summarizeConstants reports the worst platform, per-platform records and the margin', () => {
    const rec = (os, durationMs) => ({ os, runId: '1', file: 'a.test.cjs', command: 'node', argv: [], durationMs, startedAt: 's' });
    const attribution = {
      credited: { CLASS_A_MS: [rec('win32', 100), rec('win32', 300), rec('linux', 200)] },
      ambiguous: [{ candidates: ['CLASS_A_MS', 'CLASS_B_MS'] }],
    };
    const files = { 'tests/a.test.cjs': SEAM_IMPORT };
    const out = script.summarizeConstants({
      names: ['CLASS_A_MS'],
      values: { CLASS_A_MS: 1000 },
      sites: [seamSite('tests/a.test.cjs', 1, ['CLASS_A_MS'])],
      lanes: [lane('win32', []), lane('linux', [])],
      index: script.createRepoIndex(viewOf(files)),
      attribution,
    }).CLASS_A_MS;
    assert.equal(out.worst.platform, 'win32');
    assert.equal(out.perPlatform.win32.max, 300);
    assert.equal(out.margin, 3.33);
    assert.equal(out.perPlatform.win32.records, 2);
    assert.equal(out.perPlatform.darwin.records, 0);
    assert.equal(out.ambiguousCandidateCount, 1);
  });
});

describe('raw site listing', () => {
  test('raw sites are listed per constant as unchecked task lines, sorted by file then line, seam sites omitted', () => {
    const sites = [
      { file: 'tests/b.test.cjs', line: 4, constants: ['CLASS_A_MS'], cls: 'DIRECT' },
      { file: 'tests/a.test.cjs', line: 12, constants: ['CLASS_A_MS', 'CLASS_E_MS'], cls: 'DIRECT' },
      { file: 'tests/a.test.cjs', line: 3, constants: ['CLASS_A_MS'], cls: 'DIRECT' },
      { file: 'tests/c.test.cjs', line: 1, constants: ['CLASS_A_MS'], cls: 'SEAM' },
    ];
    const text = script.rawSiteLines(sites, ['CLASS_A_MS', 'CLASS_E_MS', 'CLASS_F_MS']);
    assert.equal(text, [
      '## CLASS_A_MS', '',
      '- [ ] tests/a.test.cjs:3 (CLASS_A_MS)',
      '- [ ] tests/a.test.cjs:12 (CLASS_A_MS)',
      '- [ ] tests/b.test.cjs:4 (CLASS_A_MS)', '',
      '## CLASS_E_MS', '',
      '- [ ] tests/a.test.cjs:12 (CLASS_E_MS)', '',
    ].join('\n'));
  });
});
