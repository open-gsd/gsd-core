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
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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
