'use strict';

/**
 * Platform-sensitive tests split out of tests/phase.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/phase.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - "#3785 adversarial: two plan IDs differing only by case produce a collision
 *   error" — skip-gated on `process.platform !== 'linux'`: the collision this
 *   test proves can only be constructed on a case-sensitive filesystem
 *   (process-platform).
 * - "an fs failure inside the staleness check adds a warning; completion routing
 *   is unchanged" — skip-gated on `process.platform === 'win32'` and builds a
 *   dangling symlink to force a real ENOENT inside the staleness check;
 *   symlink creation needs privilege on Windows (process-platform,
 *   win32-darwin-literal, symlink-keyword).
 * - "a BLOCKED completion (status=human_needed) with an indeterminate staleness
 *   check still blocks, but the error note says so" — same dangling-symlink
 *   fault injection as the test above, opposite (blocked) branch
 *   (process-platform, win32-darwin-literal, symlink-keyword).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { runGsdTools, createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { join } = path;

describe('phase-plan-index command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // #3785 adversarial: two plan IDs that are identical when case-folded must
  // fail fast with a clear error instead of silently routing edges to the wrong plan.
  // This test can only run on Linux where the filesystem is case-sensitive.
  // On macOS/Windows (case-insensitive FS), writing both files silently collapses
  // them to one file, so the collision scenario cannot be triggered via disk.
  test('#3785 adversarial: two plan IDs differing only by case produce a collision error', {
    skip: process.platform !== 'linux' ? 'case-insensitive filesystem — collision test requires Linux' : false,
  }, () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '21-collision');
    fs.mkdirSync(phaseDir, { recursive: true });

    // '21-01-auth-PLAN.md' → id '21-01-auth'
    // '21-01-Auth-PLAN.md' → id '21-01-Auth'
    // Both lowercase to '21-01-auth' — collision.
    fs.writeFileSync(
      path.join(phaseDir, '21-01-auth-PLAN.md'),
      `---\nautonomous: true\ndepends_on: []\n---\n<objective>lowercase.</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '21-01-Auth-PLAN.md'),
      `---\nautonomous: true\ndepends_on: []\n---\n<objective>uppercase.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 21', tmpDir);
    // The command must exit with an error (non-success) naming the collision.
    assert.ok(!result.success, 'phase-plan-index must fail when two plan IDs collide under case-folding');
    assert.ok(
      /collision/i.test(result.error ?? result.output ?? ''),
      `Error output must mention 'collision', got: ${result.error ?? result.output}`,
    );
  });
});

// ── Fixture builder (duplicated from tests/phase.test.cjs's module-scope
// helper — the base file's createFixture/writePassedVerificationFile/
// capturePhaseComplete are used by hundreds of unrelated, non-platform tests
// there and are not exported, so the two tests below reproduce only what
// they need). ─────────────────────────────────────────────────────────────

function writePassedVerificationFile(phaseDir, phase = '01') {
  fs.writeFileSync(path.join(phaseDir, `${phase}-VERIFICATION.md`), [
    '---',
    'status: passed',
    '---',
    '',
    '# Verification',
    '',
  ].join('\n'));
}

/**
 * Creates a minimal fixture project with:
 *   - ROADMAP.md with a 4-column progress table (Phase | Plans | Status | Completed)
 *   - REQUIREMENTS.md with a phase-scoped REQ-ID and Traceability row
 *   - STATE.md with Completed Phases: 0 and Total Phases: 2 (Progress 0%)
 *   - Phase 01 directory with one plan+summary (to satisfy phase complete guard)
 *   - Phase 02 directory (next phase)
 */
function createFixture(prefix = 'gsd-4-regression-', phase01DirName = '01-foundation') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  // ROADMAP.md: Phase 01 not yet complete, Phase 02 not started
  // 4-column progress table: Phase | Plans Complete | Status | Completed
  const roadmap = [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Foundation',
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Requirements:** REQ-1',
    '**Plans:** 1 plans',
    '',
    '### Phase 02: API',
    '**Goal:** Build the API',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap);

  const requirements = [
    '# Requirements',
    '',
    '## Functional Requirements',
    '',
    '- [ ] **REQ-1** Foundation must be complete.',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '| REQ-1 | Phase 01 | Pending |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'REQUIREMENTS.md'), requirements);

  // STATE.md: Completed Phases: 0, Total Phases: 2, Progress: 0%
  // Uses body-field format (bold **Field:** value) so the CJS handler's
  // stateExtractField/stateReplaceField path is exercised.
  const state = [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Current Plan:** 01-01',
    '**Last Activity:** 2025-01-01',
    '**Last Activity Description:** Working on phase 1',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), state);

  // Phase 01 directory with a PLAN and SUMMARY so phase complete guard passes
  const phase01Dir = path.join(phasesDir, phase01DirName);
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');
  writePassedVerificationFile(phase01Dir);

  // Phase 02 directory (needed for "next phase" detection)
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

function capturePhaseComplete(t, cwd, phaseNum) {
  const result = runGsdTools(['phase', 'complete', String(phaseNum)], cwd);
  if (!result.success) {
    // Surface exitCode/error verbatim so a real failure never presents as a
    // downstream `JSON.parse('')` error, and so assert.throws() callers keep
    // matching against the real stderr text (e.g. "verification is
    // incomplete...").
    throw new Error(
      result.error || `cmdPhaseComplete failed (exitCode=${result.exitCode})`,
    );
  }
  return result.output;
}

describe('#3057 B3: cmdPhaseComplete — verification staleness-check indeterminate is surfaced', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture('gsd-3057-b3-phase-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test(
    'an fs failure inside the staleness check adds a warning; completion routing is unchanged',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false },
    (t) => {
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const summaryPath = path.join(phase01Dir, '01-01-SUMMARY.md');

    // Real, on-disk fault instead of an in-process fs.statSync mock: this now
    // runs cmdPhaseComplete in a subprocess (via capturePhaseComplete), which
    // cannot see a mock installed in this process. findStaleVerificationSummary
    // (verification.cjs) calls fs.statSync on each summary file to compare
    // mtimes, and statSync follows symlinks — so pointing the summary at a
    // target that does not exist reproduces a genuine ENOENT there, degrading
    // the staleness check to {determined:false} exactly like the removed
    // injected statSync throw did. scanPhasePlans only matches summary
    // *filenames* (never stats them), so the plan-coverage gate still sees
    // the summary as present.
    fs.unlinkSync(summaryPath);
    fs.symlinkSync(path.join(phase01Dir, '.does-not-exist'), summaryPath);

    const output = JSON.parse(capturePhaseComplete(t, tmpDir, '1'));

    // Pre-existing no-throw fail-open routing is UNCHANGED: the phase still
    // completes exactly as it would have before #3057 B3.
    assert.strictEqual(output.completed_phase, '1');
    assert.ok(Array.isArray(output.warnings), 'result must carry a warnings array');
    assert.strictEqual(
      output.verification_stale_check_indeterminate,
      true,
      `result must surface the indeterminate staleness check as a typed field; got ${JSON.stringify(output.warnings)}`,
    );
    assert.strictEqual(output.has_warnings, true);
    },
  );

  test(
    'a BLOCKED completion (status=human_needed) with an indeterminate staleness check still blocks, but the error note says so',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false },
    () => {
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\nDo the work.\n');
    fs.writeFileSync(path.join(phase02Dir, '02-VERIFICATION.md'), [
      '---',
      'status: human_needed',
      '---',
      '',
      '# Verification',
      '',
    ].join('\n'));

    // Real, on-disk fault — see the note in the sibling test above. The
    // summary is a dangling symlink so fs.statSync (inside
    // findStaleVerificationSummary, running in the subprocess) throws ENOENT.
    const summaryPath = path.join(phase02Dir, '02-01-SUMMARY.md');
    fs.symlinkSync(path.join(phase02Dir, '.does-not-exist'), summaryPath);

    // Routing is UNCHANGED — status !== 'passed' already blocked before #3057
    // B3; the note is purely additive to the message text. Assert the fact
    // structurally (via --json-errors) rather than regexing the human-
    // readable note — CONTRIBUTING requires a typed surface alongside any
    // text a caller might otherwise only match on, and once that typed
    // surface exists the test must assert on IT, not also on the rendered
    // prose (src/phase.cts's human message wording is out of scope for this
    // test — operators read it, but the test must not lock its exact text).
    const result = runGsdTools(['--json-errors', 'phase', 'complete', '2'], tmpDir);
    assert.equal(result.success, false, 'phase complete must fail when verification is blocked');
    const errorPayload = JSON.parse(result.error);
    assert.equal(errorPayload.reason, 'phase_verification_incomplete');
    assert.equal(errorPayload.verification_stale_check_indeterminate, true);
    },
  );
});

// ─── #5789: a non-regular SUMMARY must never hang the status predicates ────
//
// Moved from tests/summary-status-blocked-3345.test.cjs: these rows need a POSIX
// filesystem (mkfifo, symlinks, /dev/zero) and spawn child processes, so they
// carry the platform signal (process-platform, win32-darwin-literal,
// symlink-keyword, spawn). Every hang row runs in a CHILD process with a hard
// timeout + SIGKILL, so on unfixed code the row fails by timing out instead of
// hanging the suite.

function tempDir(prefix) {
  return fs.mkdtempSync(join(os.tmpdir(), prefix));
}

const IS_WIN_5789 = process.platform === 'win32';
const PLAN_MODULE_5789 = require.resolve('../gsd-core/bin/lib/plan-dependency-graph.cjs');

function runChild5789(args, cwd) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return { ...r, timedOut: Boolean(timedOut) };
}

// Calls one exported predicate on `summaryPath` in a child; returns the boolean.
function probePredicate5789(name, summaryPath) {
  const script =
    'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(m[process.argv[2]](process.argv[3])));';
  const r = runChild5789(['-e', script, PLAN_MODULE_5789, name, summaryPath], os.tmpdir());
  assert.equal(r.timedOut, false, `#5789: ${name}(${summaryPath}) did not return within the probe timeout`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function makeFifo5789(file) {
  execFileSync('mkfifo', [file], { timeout: PROBE_TIMEOUT_MS });
}

function writeCliPhase5789(projectDir, { fifo }) {
  const phaseDir = join(projectDir, '.planning', 'phases', '01-test');
  fs.mkdirSync(phaseDir, { recursive: true });
  const planFm = [
    '---',
    'phase: 01-test',
    'plan: "01"',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    '---',
    '# plan',
    '',
  ].join('\n');
  fs.writeFileSync(join(phaseDir, '01-01-PLAN.md'), planFm);
  if (fifo) makeFifo5789(join(phaseDir, '01-01-SUMMARY.md'));
  return phaseDir;
}

describe('#5789 FIFO SUMMARY — predicates return promptly', { skip: IS_WIN_5789 }, () => {
  test('#5789 row 1: isSummaryFileHalted on a FIFO returns false', () => {
    const dir = tempDir('gsd-5789-r1-');
    try {
      const fifo = join(dir, '01-01-SUMMARY.md');
      makeFifo5789(fifo);
      assert.equal(probePredicate5789('isSummaryFileHalted', fifo), false);
    } finally {
      cleanup(dir);
    }
  });

  test('#5789 row 2: isSummaryFileBlocked on a FIFO returns false', () => {
    const dir = tempDir('gsd-5789-r2-');
    try {
      const fifo = join(dir, '01-01-SUMMARY.md');
      makeFifo5789(fifo);
      assert.equal(probePredicate5789('isSummaryFileBlocked', fifo), false);
    } finally {
      cleanup(dir);
    }
  });

  test('#5789 row 7: symlink to /dev/zero is not read by either predicate', () => {
    if (!fs.existsSync('/dev/zero')) return;
    const dir = tempDir('gsd-5789-r7-');
    try {
      const link = join(dir, '01-01-SUMMARY.md');
      fs.symlinkSync('/dev/zero', link);
      assert.equal(probePredicate5789('isSummaryFileHalted', link), false);
      assert.equal(probePredicate5789('isSummaryFileBlocked', link), false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('#5789 FIFO SUMMARY — CLI commands exit promptly', { skip: IS_WIN_5789 }, () => {
  const CLI_ROWS = [
    { row: 3, args: ['phase-plan-index', '01-test', '--json'] },
    { row: 4, args: ['init', 'execute-phase', '1'] },
    { row: 5, args: ['init', 'plan-phase', '1'] },
  ];
  for (const { row, args } of CLI_ROWS) {
    test(`#5789 row ${row}: gsd-tools ${args.slice(0, 2).join(' ')} with a FIFO SUMMARY exits`, () => {
      const project = createTempProject(`gsd-5789-cli${row}-`);
      try {
        writeCliPhase5789(project, { fifo: true });
        const r = runChild5789([TOOLS_PATH, ...args], project);
        assert.equal(r.timedOut, false, `#5789: gsd-tools ${args.join(' ')} hung on a FIFO SUMMARY`);
        assert.equal(r.status, 0, r.stderr || r.stdout);
      } finally {
        cleanup(project);
      }
    });
  }

  test('#5789 row 6: phase lookup (searchPhaseInDir) with a FIFO SUMMARY does not hang', () => {
    const project = createTempProject('gsd-5789-r6-');
    try {
      writeCliPhase5789(project, { fifo: true });
      const r = runChild5789([TOOLS_PATH, 'find-phase', '1'], project);
      assert.equal(r.timedOut, false, '#5789: find-phase hung on a FIFO SUMMARY');
      assert.equal(r.status, 0, r.stderr || r.stdout);
      let found;
      assert.doesNotThrow(() => { found = JSON.parse(r.stdout); }, `#5789: find-phase stdout must be JSON, got: ${r.stdout}`);
      assert.equal(found.found, true, `#5789: find-phase must locate the fixture phase, got: ${r.stdout}`);
      assert.match(found.directory, /(^|\/)01-test$/, `#5789: find-phase must resolve to 01-test, got: ${found.directory}`);
    } finally {
      cleanup(project);
    }
  });
});

describe('#5789 symlinked SUMMARY behaviour', () => {
  test('#5789 row 12: symlink to a regular halted file is still followed', { skip: IS_WIN_5789 }, () => {
    const dir = tempDir('gsd-5789-r12-');
    try {
      const target = join(dir, '01-01-SUMMARY.md');
      fs.writeFileSync(target, '---\nstatus: halted\n---\n\n# Summary\n');
      const link = join(dir, '01-02-SUMMARY.md');
      fs.symlinkSync(target, link);
      assert.equal(probePredicate5789('isSummaryFileHalted', link), true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('#5789 parity — unreadable input classes treated the same way by both predicates', () => {
  const INPUT_CLASSES = [
    { id: 'dev-zero-symlink', make: (dir) => { const f = join(dir, 's.md'); fs.symlinkSync('/dev/zero', f); return f; }, halted: false, blocked: false, posix: true },
    // Each predicate runs in a child with a hard timeout + SIGKILL
    // (probePredicate5789), so a FIFO that blocks the open cannot hang the suite.
    { id: 'fifo', make: (dir) => { const f = join(dir, 's.md'); makeFifo5789(f); return f; }, halted: false, blocked: false, posix: true },
  ];
  for (const cls of INPUT_CLASSES) {
    test(`#5789 parity: ${cls.id} — halted and blocked agree on whether the file is read`, { skip: cls.posix && IS_WIN_5789 }, () => {
      const dir = tempDir(`gsd-5789-par-${cls.id}-`);
      try {
        const f = cls.make(dir);
        const halted = probePredicate5789('isSummaryFileHalted', f);
        const blocked = probePredicate5789('isSummaryFileBlocked', f);
        assert.equal(halted, cls.halted, `#5789 parity: ${cls.id} isSummaryFileHalted`);
        assert.equal(blocked, cls.blocked, `#5789 parity: ${cls.id} isSummaryFileBlocked`);
      } finally {
        cleanup(dir);
      }
    });
  }
});
