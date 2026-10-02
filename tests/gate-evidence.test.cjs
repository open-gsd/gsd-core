'use strict';

/**
 * Gate evidence (#5170, epic #5056, ADR-5057 §4 third bullet).
 *
 * `src/gate-evidence.cts` gives a gate three answers for a read — found / none /
 * unreadable — and `verdictFromEvidence` maps them to a verdict whose
 * `unreadable` arm cannot return a passing outcome. Matrix rows 1-6.
 *
 * Failures are injected by replacing the fs method for the duration of one call
 * and restoring it in `finally` (ADR-3574) — never by chmod, which root bypasses.
 */

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempProject, cleanup } = require('./helpers.cjs');
const {
  readTextEvidence,
  readDirEvidence,
  verdictFromEvidence,
  evidenceFound,
  evidenceNone,
  evidenceUnreadable,
} = require('../gsd-core/bin/lib/gate-evidence.cjs');
const { gateVerdict, gateUnreadable } = require('../gsd-core/bin/lib/gate-verdict.cjs');
const { withFsFailure } = require('./helpers/fs-failure.cjs');

describe('gate-evidence — readTextEvidence', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('gate-evidence › missing file is none', () => {
    assert.deepEqual(readTextEvidence(path.join(tmpDir, 'absent.md')), { kind: 'none' });
  });

  test('gate-evidence › directory is unreadable', () => {
    const ev = readTextEvidence(tmpDir);
    assert.equal(ev.kind, 'unreadable');
    assert.equal(ev.reason, 'EISDIR', 'the reason names the errno, not a generic message');
    assert.equal(ev.span, tmpDir);
  });

  test('gate-evidence › EACCES is unreadable', () => {
    const target = path.join(tmpDir, 'locked.md');
    fs.writeFileSync(target, 'content');
    const ev = withFsFailure('readFileSync', target, 'EACCES', () => readTextEvidence(target));
    assert.deepEqual(ev, { kind: 'unreadable', reason: 'EACCES', span: target });
    assert.equal(readTextEvidence(target).kind, 'found', 'the patch was restored: the file reads again');
  });

  test('gate-evidence › EIO is unreadable', () => {
    const target = path.join(tmpDir, 'io.md');
    fs.writeFileSync(target, 'content');
    const ev = withFsFailure('readFileSync', target, 'EIO', () => readTextEvidence(target));
    assert.equal(ev.kind, 'unreadable');
    assert.equal(ev.reason, 'EIO');
  });

  test('gate-evidence › withFsFailure refuses a method fs does not have (a typo cannot inject nothing)', () => {
    let ran = false;
    assert.throws(
      () => withFsFailure('readFileSyncc', 'x', 'EACCES', () => { ran = true; }),
      /fs\.readFileSyncc is not a function/,
    );
    assert.equal(ran, false, 'the body never runs under a failure that was not injected');
    assert.throws(() => withFsFailure('constants', 'x', 'EACCES', () => {}), /is not a function/);
  });

  test('gate-evidence › a failure with no errno code carries its message', () => {
    const target = path.join(tmpDir, 'plain.md');
    fs.writeFileSync(target, 'content');
    const original = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (String(p) === target) throw new Error('decode exploded');
      return original(p, ...rest);
    };
    let ev;
    try { ev = readTextEvidence(target); } finally { fs.readFileSync = original; }
    assert.deepEqual(ev, { kind: 'unreadable', reason: 'decode exploded', span: target });
  });

  test('gate-evidence › empty file is found', () => {
    const target = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(target, '');
    assert.deepEqual(readTextEvidence(target), { kind: 'found', value: '' });
  });

  test('gate-evidence › ENOTDIR is none', () => {
    const parent = path.join(tmpDir, 'a-file');
    fs.writeFileSync(parent, 'x');
    assert.deepEqual(readTextEvidence(path.join(parent, 'child.md')), { kind: 'none' });
  });

  test('gate-evidence › any text round-trips as found (property)', () => {
    const target = path.join(tmpDir, 'roundtrip.md');
    fc.assert(
      fc.property(fc.string(), (text) => {
        fs.writeFileSync(target, text, 'utf8');
        const ev = readTextEvidence(target);
        return ev.kind === 'found' && ev.value === text;
      }),
      { seed: 5170, numRuns: 50 },
    );
  });
});

describe('gate-evidence — readDirEvidence', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('gate-evidence › missing directory is none', () => {
    assert.deepEqual(readDirEvidence(path.join(tmpDir, 'absent')), { kind: 'none' });
  });

  test('gate-evidence › an empty directory is found with no entries', () => {
    const dir = path.join(tmpDir, 'empty');
    fs.mkdirSync(dir);
    assert.deepEqual(readDirEvidence(dir), { kind: 'found', value: [] });
  });

  test('gate-evidence › entries are returned as found', () => {
    const dir = path.join(tmpDir, 'with-entries');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.md'), '');
    fs.writeFileSync(path.join(dir, 'b.md'), '');
    const ev = readDirEvidence(dir);
    assert.equal(ev.kind, 'found');
    assert.deepEqual([...ev.value].sort(), ['a.md', 'b.md']);
  });

  test('gate-evidence › readdir EACCES is unreadable, never an empty list', () => {
    const dir = path.join(tmpDir, 'locked');
    fs.mkdirSync(dir);
    const ev = withFsFailure('readdirSync', dir, 'EACCES', () => readDirEvidence(dir));
    assert.deepEqual(ev, { kind: 'unreadable', reason: 'EACCES', span: dir });
  });

  test('gate-evidence › a parent that is a file is none (ENOTDIR)', () => {
    const file = path.join(tmpDir, 'a-file');
    fs.writeFileSync(file, 'x');
    assert.deepEqual(readDirEvidence(path.join(file, 'sub')), { kind: 'none' });
  });
});

describe('gate-evidence — verdictFromEvidence', () => {
  const arms = {
    found: (value) => gateVerdict('pass', false, { value }),
    none: () => gateVerdict('skip', false, { none: true }),
    unreadable: (reason, span) => gateUnreadable(true, { reason, span }),
  };

  test('gate-evidence › each kind selects its own arm', () => {
    assert.deepEqual(verdictFromEvidence(evidenceFound('v'), arms).payload, { value: 'v' });
    assert.equal(verdictFromEvidence(evidenceNone(), arms).outcome, 'skip');
    const unreadable = verdictFromEvidence(evidenceUnreadable('EIO', '/p'), arms);
    assert.equal(unreadable.outcome, 'unreadable');
    assert.equal(unreadable.block, true, 'block is the gate policy for the arm; the outcome is what the exit follows');
    assert.deepEqual(unreadable.payload, { reason: 'EIO', span: '/p' });
  });

  test('gate-evidence › gateUnreadable freezes a copy of the payload', () => {
    const payload = { reason: 'EIO' };
    const verdict = gateUnreadable(false, payload);
    payload.reason = 'mutated';
    assert.equal(verdict.payload.reason, 'EIO');
    assert.ok(Object.isFrozen(verdict.payload));
    assert.equal(verdict.outcome, 'unreadable');
  });

  test('gate-evidence › evidenceUnreadable omits span when none is given', () => {
    assert.deepEqual(evidenceUnreadable('EIO'), { kind: 'unreadable', reason: 'EIO' });
  });
});

// ─── row 6: the unreadable arm cannot return a pass (compile-time) ─────────────
//
// The oracle is the TypeScript compiler driven in-process against the repo's REAL
// tsconfig.build.json strictness (the pattern of tests/phase-estimation.test.cjs,
// #2671). Assertions are on diagnostic OBJECTS (`code`, position), never prose.

describe('gate-evidence › unreadable arm cannot return pass', () => {
  const ts = require('typescript');
  const REPO_ROOT = path.join(__dirname, '..');
  const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'gate-evidence-typing');
  /** TS2741: "Property [brand] is missing in type GateVerdict but required in type UnreadableVerdict". */
  const TS_BRAND_MISSING = 2741;
  const OFFENDING = 'OFFENDING';

  const CASES = [
    { fixture: 'ok-unreadable-arm.cts', expected: null },
    { fixture: 'bad-pass-from-unreadable.cts', expected: TS_BRAND_MISSING },
    { fixture: 'bad-unbranded-unreadable.cts', expected: TS_BRAND_MISSING },
  ];

  /** Spans of every `OFFENDING` identifier, located through the AST. */
  function markerSpans(sourceFile) {
    const spans = [];
    const visit = (node) => {
      if (ts.isIdentifier(node) && node.text === OFFENDING) spans.push([node.getStart(sourceFile), node.getEnd()]);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return spans;
  }

  let byFixture;
  let foreign;
  let sourceFileOf;

  before(() => {
    const readConfig = ts.readConfigFile(path.join(REPO_ROOT, 'tsconfig.build.json'), ts.sys.readFile);
    assert.equal(readConfig.error, undefined, 'tsconfig.build.json must parse');
    const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, REPO_ROOT);
    assert.deepEqual(parsed.errors, [], 'tsconfig.build.json must yield usable compiler options');
    const options = { ...parsed.options, noEmit: true, rootDir: undefined, outDir: undefined, incremental: false, tsBuildInfoFile: undefined };
    const roots = CASES.map((c) => path.join(FIXTURE_DIR, c.fixture));
    const program = ts.createProgram(roots, options);
    byFixture = new Map(CASES.map((c) => [c.fixture, []]));
    foreign = [];
    sourceFileOf = new Map(CASES.map((c) => [c.fixture, program.getSourceFile(path.join(FIXTURE_DIR, c.fixture))]));
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const name = diagnostic.file === undefined ? null : path.basename(diagnostic.file.fileName);
      if (name !== null && byFixture.has(name)) byFixture.get(name).push(diagnostic);
      else foreign.push(diagnostic);
    }
  });

  test('gate-evidence › the positive control compiles clean (the harness is sound)', () => {
    assert.deepEqual(byFixture.get('ok-unreadable-arm.cts').map((d) => d.code), []);
  });

  for (const { fixture, expected } of CASES.filter((c) => c.expected !== null)) {
    test(`gate-evidence › ${fixture} fails with exactly one diagnostic, on the OFFENDING node`, () => {
      const diagnostics = byFixture.get(fixture);
      assert.deepEqual(diagnostics.map((d) => d.code), [expected]);
      const spans = markerSpans(sourceFileOf.get(fixture));
      assert.ok(spans.length > 0, 'the fixture must carry the OFFENDING marker');
      const at = diagnostics[0].start;
      assert.ok(spans.some(([start, end]) => at >= start && at < end), 'the diagnostic lands on the marker, not on an unrelated error');
    });
  }

  test('gate-evidence › no diagnostic originates outside the fixture directory', () => {
    assert.deepEqual(
      foreign.map((d) => `${d.file === undefined ? '(global)' : path.relative(REPO_ROOT, d.file.fileName)}:${d.code}`),
      [],
      'a real compile error in the module under test would otherwise hide behind the fixtures',
    );
  });
});
