'use strict';

/**
 * Behavioral suite for scripts/timeout-evidence-from-ci.cjs (#4689), the script that reproduces the
 * CI figures in tests/helpers/timeouts.cjs TIMEOUT_EVIDENCE. Every input is synthetic: source
 * strings fed through an in-memory view, and records written as jsonl text. The CLASS_*_MS names
 * below are neutral test data standing in for timeouts.cjs exports. No wall-clock values are
 * asserted. The one repository-level test (drift guard) feeds the real tests/ tree through the
 * script's own census and compares counts with TIMEOUT_EVIDENCE; it matches no source text.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

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

  describe('exclusion resolutions', () => {
    const SPAWNER_FILE = { 'tests/spawner.test.cjs': "const projection = require('../src/shell-command-projection.cjs');\nprojection.execArgvQuarantined('git', [], { timeoutMs: CLASS_A_MS });\n" };
    const UNDER_TEST = { file: 'tests/spawner.test.cjs', callee: 'projection.execArgvQuarantined', kind: 'UNDER_TEST', reason: 'asserts the spawner outcomes' };

    function buildWith(files, resolutions) {
      const view = viewOf(files);
      return script.buildSites(script.censusRepo(view, NAMES), script.createClassifier(view), resolutions);
    }

    test('an under-test callee is excluded from sites and unresolved sites and reported with its kind and reason', () => {
      const r = buildWith(SPAWNER_FILE, [UNDER_TEST]);
      assert.deepEqual(r.sites, []);
      assert.deepEqual(r.unresolvedSites, []);
      assert.deepEqual(r.unusedResolutions, []);
      assert.deepEqual(r.excludedSites.map((x) => [x.file, x.line, x.kind, x.reason]), [['tests/spawner.test.cjs', 2, 'UNDER_TEST', 'asserts the spawner outcomes']]);
    });

    test('an exempt direct spawn is excluded, not counted as a raw site', () => {
      const files = { 'tests/raw.test.cjs': "const cp = require('node:child_process');\ncp.spawnSync('git', [], { timeout: CLASS_A_MS });\n" };
      assert.equal(buildWith(files, []).sites[0].cls, 'DIRECT');
      const r = buildWith(files, [{ file: 'tests/raw.test.cjs', callee: 'cp.spawnSync', kind: 'EXEMPT', reason: 'deliberate' }]);
      assert.deepEqual(r.sites, []);
      assert.deepEqual(r.excludedSites.map((x) => x.kind), ['EXEMPT']);
    });

    const CLASSIFIED = { file: 'tests/spawner.test.cjs', callee: 'projection.execArgvQuarantined', cls: 'SEAM', resolvedCallee: 'runNode', note: 'forwarded' };
    const NAMED = /resolution tests\/spawner\.test\.cjs projection\.execArgvQuarantined: /;

    test('rule a: a resolution that sets both kind and cls throws, naming file and callee', () => {
      assert.throws(() => buildWith(SPAWNER_FILE, [{ ...UNDER_TEST, cls: 'SEAM' }]), new RegExp(NAMED.source + 'sets both kind and cls'));
    });

    test('rule b: a resolution that sets neither kind nor cls throws, naming file and callee', () => {
      assert.throws(() => buildWith(SPAWNER_FILE, [{ file: UNDER_TEST.file, callee: UNDER_TEST.callee }]), new RegExp(NAMED.source + 'sets neither kind nor cls'));
    });

    test('rule c: an unknown kind throws, naming file and callee', () => {
      assert.throws(() => buildWith(SPAWNER_FILE, [{ ...UNDER_TEST, kind: 'BOGUS' }]), new RegExp(NAMED.source + 'unknown kind'));
    });

    test('rule d: a kind resolution with a missing, empty or blank reason throws, naming file and callee', () => {
      for (const reason of [undefined, '', '   ']) {
        assert.throws(() => buildWith(SPAWNER_FILE, [{ ...UNDER_TEST, reason }]), new RegExp(NAMED.source + 'kind UNDER_TEST requires a non-empty reason'));
      }
    });

    test('rule e: an unknown cls throws, naming file and callee', () => {
      assert.throws(() => buildWith(SPAWNER_FILE, [{ ...CLASSIFIED, cls: 'BOGUS' }]), new RegExp(NAMED.source + 'unknown cls'));
    });

    test('rule f: a cls resolution with a missing, empty or blank resolvedCallee or note throws, naming file and callee', () => {
      for (const v of [undefined, '', '   ']) {
        assert.throws(() => buildWith(SPAWNER_FILE, [{ ...CLASSIFIED, resolvedCallee: v }]), new RegExp(NAMED.source + 'cls SEAM requires a non-empty resolvedCallee'));
        assert.throws(() => buildWith(SPAWNER_FILE, [{ ...CLASSIFIED, note: v }]), new RegExp(NAMED.source + 'cls SEAM requires a non-empty note'));
      }
    });

    test('a well-formed kind resolution and a well-formed cls resolution both validate', () => {
      assert.doesNotThrow(() => script.validateResolutions([UNDER_TEST, CLASSIFIED]));
    });

    test('property: validateResolutions throws exactly when a resolution violates rules a-f', () => {
      const orUndef = (arb) => fc.oneof(fc.constant(undefined), arb);
      fc.assert(
        fc.property(
          orUndef(fc.constantFrom('UNDER_TEST', 'EXEMPT', 'BOGUS')),
          orUndef(fc.constantFrom('SEAM', 'DIRECT', 'BOGUS')),
          orUndef(fc.constantFrom('', '   ', 'why')),
          orUndef(fc.constantFrom('', '   ', 'runNode')),
          orUndef(fc.constantFrom('', '   ', 'note')),
          (kind, cls, reason, resolvedCallee, note) => {
            const entry = { file: 'tests/p.test.cjs', callee: 'c' };
            for (const [k, v] of Object.entries({ kind, cls, reason, resolvedCallee, note })) if (v !== undefined) entry[k] = v;
            const ok = (v) => v !== undefined && v.trim() !== '';
            let violates;
            if (kind !== undefined && cls !== undefined) violates = true;
            else if (kind === undefined && cls === undefined) violates = true;
            else if (kind !== undefined) violates = !['UNDER_TEST', 'EXEMPT'].includes(kind) || !ok(reason);
            else violates = !['SEAM', 'DIRECT'].includes(cls) || !ok(resolvedCallee) || !ok(note);
            if (violates) assert.throws(() => script.validateResolutions([entry]), /resolution tests\/p\.test\.cjs c: /);
            else assert.doesNotThrow(() => script.validateResolutions([entry]));
          },
        ),
      );
    });

    test('a resolution whose optionKey no site carries is reported as unused and excludes nothing', () => {
      const r = buildWith(SPAWNER_FILE, [{ ...UNDER_TEST, optionKey: 'stdio' }]);
      assert.deepEqual(r.unusedResolutions.map((o) => o.optionKey), ['stdio']);
      assert.deepEqual(r.excludedSites, []);
      assert.equal(r.sites.length, 1);
    });

    test('an under-test resolution that matches nothing is reported as unused', () => {
      const r = buildWith({ 'tests/other.test.cjs': 'const x = 1;\n' }, [UNDER_TEST]);
      assert.deepEqual(r.unusedResolutions.map((o) => o.file), ['tests/spawner.test.cjs']);
      assert.deepEqual(r.excludedSites, []);
    });

    test('the agent-skills stdio exemption matches exactly one site and leaves the file\'s other direct sites counted', () => {
      const src = "const { spawnSync } = require('child_process');\n" +
        "spawnSync('node', [], { timeout: CLASS_A_MS });\n" +
        "spawnSync('node', [], { stdio: ['ignore', 1, 'pipe'], timeout: CLASS_A_MS });\n" +
        "spawnSync('node', [], { timeout: CLASS_A_MS });\n";
      const exemption = script.MANUAL_RESOLUTIONS.find((o) => o.file === 'tests/agent-skills.test.cjs');
      assert.equal(exemption.kind, 'EXEMPT');
      const r = buildWith({ 'tests/agent-skills.test.cjs': src }, [exemption]);
      assert.deepEqual(r.excludedSites.map((x) => x.line), [3]);
      assert.deepEqual(r.sites.map((x) => [x.line, x.cls]), [[2, 'DIRECT'], [4, 'DIRECT']]);
    });
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
    assert.equal(l.skippedLines, 1);
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

describe('attribution: command and helper compatibility', () => {
  const VALUES = { CLASS_A_MS: BOUND_SMALL, CLASS_D_MS: BOUND_LARGE };
  const FILE = 'tests/a.test.cjs';
  const HELPER = 'tests/helpers/h.cjs';
  const helperFiles = (call) => ({
    'tests/b.test.cjs': "const h = require('./helpers/h.cjs');\n",
    [HELPER]: SEAM_IMPORT + 'module.exports = () => ' + call + ';\n',
  });

  test('a single candidate whose callee is incompatible with the record command is unmatched, a compatible one is credited', () => {
    const files = { [FILE]: SEAM_IMPORT + "runGit(['status'], { timeoutMs: CLASS_A_MS });\n" };
    const sites = [seamSite(FILE, 2, ['CLASS_A_MS'], 'runGit')];
    const bad = attribute(files, sites, VALUES, [lane('linux', [stall({ command: 'node' })])]);
    assert.equal(bad.unmatched.length, 1);
    assert.deepEqual(bad.credited, {});
    const good = attribute(files, sites, VALUES, [lane('linux', [stall({ command: 'git' })])]);
    assert.equal(good.credited.CLASS_A_MS.length, 1);
    assert.equal(good.unmatched.length, 0);
  });

  test('a record reaching a helper site is credited only when its argv shows one of the site literals', () => {
    const files = helperFiles("runNode(['alpha.js'], { timeoutMs: CLASS_A_MS })");
    const sites = [seamSite(HELPER, 2, ['CLASS_A_MS'])];
    const hit = attribute(files, sites, VALUES, [lane('linux', [stall({ file: 'b.test.cjs', argv: ['/tmp/alpha.js'] })])]);
    assert.equal(hit.credited.CLASS_A_MS.length, 1);
    assert.equal(hit.credited.CLASS_A_MS[0].viaHelper, true);
    assert.equal(hit.viaHelper, 1);
    const miss = attribute(files, sites, VALUES, [lane('linux', [stall({ file: 'b.test.cjs', argv: ['/tmp/other.js'] })])]);
    assert.equal(miss.unmatched.length, 1);
    assert.deepEqual(miss.credited, {});
    assert.equal(miss.viaHelper, 0);
  });

  test('a helper site that holds no literal is credited without argv evidence', () => {
    const files = helperFiles('runNode([], { timeoutMs: CLASS_A_MS })');
    const r = attribute(files, [seamSite(HELPER, 2, ['CLASS_A_MS'])], VALUES, [lane('linux', [stall({ file: 'b.test.cjs', argv: ['whatever'] })])]);
    assert.equal(r.credited.CLASS_A_MS.length, 1);
  });

  test('a helper site whose callee is incompatible with the record command is unmatched', () => {
    const files = helperFiles("runGit(['status'], { timeoutMs: CLASS_A_MS })");
    const r = attribute(files, [seamSite(HELPER, 2, ['CLASS_A_MS'], 'runGit')], VALUES, [lane('linux', [stall({ file: 'b.test.cjs', command: 'node', argv: ['status'] })])]);
    assert.equal(r.unmatched.length, 1);
  });

  test('site literals shorter than 3 characters and flags are ignored: lengths 2, 3 and 4', () => {
    const files = { [FILE]: SEAM_IMPORT + "runNode(['ab', 'abc', 'abcd', '-ee', '--flag', '-e'], { timeoutMs: CLASS_A_MS });\n" };
    const index = script.createRepoIndex(viewOf(files));
    assert.deepEqual(index.siteShape(seamSite(FILE, 2, ['CLASS_A_MS'])).lits.sort(), ['abc', 'abcd']);
  });
});

describe('classification: dotted callees', () => {
  const NAMES = ['CLASS_A_MS'];
  const sitesOf = (files) => {
    const view = viewOf(files);
    return script.buildSites(script.censusRepo(view, NAMES), script.createClassifier(view), []);
  };

  test('a three-part callee uses its last segment as the method and the rest as the object', () => {
    const { sites, unresolvedSites } = sitesOf({ 'tests/x.test.cjs': "const o = {};\no.cp.execFileSync('git', [], { timeout: CLASS_A_MS });\n" });
    assert.equal(sites[0].cls, 'DIRECT');
    assert.deepEqual(unresolvedSites, []);
  });

  test('a three-part callee whose method is not a spawn call stays unresolved', () => {
    const { unresolvedSites } = sitesOf({ 'tests/x.test.cjs': "const o = {};\no.helper.go('git', [], { timeout: CLASS_A_MS });\n" });
    assert.equal(unresolvedSites.length, 1);
    assert.equal(unresolvedSites[0].cls, 'UNKNOWN');
  });
});

describe('command line', () => {
  const parse = (...args) => script.parseArgs(args);

  test('a valid command line keeps its values and defaults', () => {
    const o = parse('--artifacts', 'dir', '--format', 'md', '--raw-sites');
    assert.equal(o.artifacts, 'dir');
    assert.equal(o.format, 'md');
    assert.equal(o.rawSites, true);
    assert.equal(parse('--artifacts', 'dir').format, 'json');
  });

  test('an unknown flag, a missing --artifacts and a bad --format are usage errors', () => {
    assert.throws(() => parse('--artifacts', 'd', '--nope'), /unknown argument: --nope/);
    assert.throws(() => parse('--format', 'md'), /--artifacts <dir> is required/);
    assert.throws(() => parse('--artifacts', 'd', '--format', 'xml'), /--format must be json or md/);
  });

  test('a flag with no value, or whose value starts with --, is a usage error', () => {
    for (const flag of ['--artifacts', '--repo', '--format']) {
      assert.throws(() => parse('--artifacts', 'd', flag), /requires a value/, flag + ' at the end');
    }
    assert.throws(() => parse('--artifacts', '--raw-sites'), /--artifacts requires a value/);
    assert.throws(() => parse('--artifacts', 'd', '--repo', '--format', 'md'), /--repo requires a value/);
  });
});

describe('loadLanes', () => {
  function withTree(layout, fn) {
    const root = createTempDir('tev-');
    try {
      for (const [rel, text] of Object.entries(layout)) {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      }
      return fn(root);
    } finally {
      cleanup(root);
    }
  }

  test('both gh layouts are read, the os comes from the artifact or file name, and the order is sorted', () => {
    const line = stall() + '\n';
    const lanes = withTree({
      '20/test-timings-windows-latest-job0/test-timings-windows-latest-job0.jsonl': line,
      '10/test-timings-ubuntu-unit-job1.jsonl': line,
      '10/test-timings-macos-latest-job3.jsonl': line + '{"type":"seam:spawn-stall", broken\n',
    }, (root) => script.loadLanes(root));
    assert.deepEqual(lanes.map((l) => [l.runId, l.os]), [['10', 'darwin'], ['10', 'linux'], ['20', 'win32']]);
    assert.equal(lanes[0].skippedLines, 1);
  });

  test('a lane whose os cannot be determined, a file outside a run directory and an empty tree are errors', () => {
    assert.throws(() => withTree({ '1/test-timings-plan.jsonl': stall() }, (root) => script.loadLanes(root)), /cannot determine the os/);
    assert.throws(() => withTree({ 'test-timings-ubuntu-unit-job1.jsonl': stall() }, (root) => script.loadLanes(root)), /outside a <runId>\/ directory/);
    assert.throws(() => withTree({ '1/notes.txt': 'x' }, (root) => script.loadLanes(root)), /no lane/);
  });
});

describe('evidence report', () => {
  const NAMES = ['CLASS_A_MS'];
  const files = { 'tests/a.test.cjs': SEAM_IMPORT + "runNode(['x.js'], { timeoutMs: CLASS_A_MS });\n" };

  function build() {
    const view = viewOf(files);
    const lanes = [
      lane('win32', [stall({ durationMs: 3000 }), stall({ durationMs: 5000 })]),
      lane('linux', [stall({ durationMs: 2500 }), stall({ file: 'other.test.cjs', durationMs: 2600 })]),
      lane('darwin', ['{"type":"seam:spawn-stall", broken']),
    ];
    const ev = script.buildEvidence({
      lanes, runDirectories: 1, view, names: NAMES, evidenceNames: NAMES, values: { CLASS_A_MS: BOUND_SMALL },
      census: script.censusRepo(view, NAMES),
    });
    return ev;
  }

  test('buildEvidence reports record counts, per-platform figures, margin and skipped lines', () => {
    const ev = build();
    assert.equal(ev.totalRecords, 4);
    assert.equal(ev.creditedRecords, 3);
    assert.equal(ev.unmatchedRecords, 1);
    assert.equal(ev.ambiguousRecords, 0);
    assert.equal(ev.window.skippedMalformedLines, 1);
    assert.deepEqual(ev.window.lanesByPlatform, { win32: 1, linux: 1, darwin: 1 });
    const c = ev.constants.CLASS_A_MS;
    assert.equal(c.seamSites, 1);
    assert.equal(c.rawSites, 0);
    assert.equal(c.viaHelper, 0);
    assert.deepEqual([c.perPlatform.win32.records, c.perPlatform.darwin.records, c.perPlatform.linux.records], [2, 0, 1]);
    assert.equal(c.perPlatform.win32.p50, 3000);
    assert.equal(c.perPlatform.win32.max, 5000);
    assert.equal(c.worst.platform, 'win32');
    assert.equal(c.margin, 3);
  });

  test('renderMarkdown prints the totals line and one table row per constant', () => {
    const lines = script.renderMarkdown(build(), NAMES).split('\n');
    assert.ok(lines.some((l) => l.includes('Records: 4; credited 3; ambiguous 0; unmatched 1;') && l.includes('malformed lines skipped 1.')));
    assert.ok(lines.includes('| CLASS_A_MS | 15000 | 1 | 0 | 2/0/1 | 0/0/0 | win32 | 5000 | 3 | 0 | 0 |'));
    assert.ok(lines.includes('| CLASS_A_MS | linux | 1 | 2500 | 2500 | 2500 |'));
  });
});

describe('repository drift guard', () => {
  test('the real tests/ tree classifies with no unresolved site and no unused resolution, and each measured constant unseenSites equals its raw site count', () => {
    const root = path.resolve(__dirname, '..');
    const T = require('./helpers/timeouts.cjs');
    const { censusNames, evidenceNames } = script.constantsFromTimeouts(T);
    const view = script.diskView(root);
    const census = script.censusRepo(view, censusNames);
    assert.deepEqual(census.parseFailures, []);
    const built = script.buildSites(census, script.createClassifier(view));
    assert.deepEqual(built.unresolvedSites, []);
    assert.deepEqual(built.unusedResolutions, []);
    for (const name of evidenceNames) {
      const entry = T.TIMEOUT_EVIDENCE[name];
      if (entry.kind !== 'measured') continue;
      const raw = built.sites.filter((s) => s.cls === 'DIRECT' && s.constants.includes(name)).length;
      assert.equal(entry.unseenSites, raw, name + ' unseenSites');
    }
  });
});
