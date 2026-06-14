'use strict';

/**
 * Regression test for issue #4 (open-gsd/gsd-core):
 *   bin/lib/phase.cjs cmdPhaseComplete — non-idempotent and unclamped.
 *
 * Root cause (pre-fix):
 *   cmdPhaseComplete blindly increments "Completed Phases" by 1 on every call
 *   (parseInt(completedRaw, 10) + 1) and recomputes Progress without a clamp.
 *   Double-calling yields Completed Phases +2 (not +1), and Progress can exceed 100%.
 *
 * Fix: derive completed_phases from ROADMAP Complete-row count (idempotent) and
 *   clamp percent to 100. This mirrors the SDK fix in phase-lifecycle.ts
 *   (commit deriving from ROADMAP, referenced as "PR #3520" in issue #4).
 *
 * Note on test structure: phase-command-router.cjs delegates to the SDK when
 *   the SDK dist is present, so the CJS path is exercised by calling
 *   cmdPhaseComplete directly (bypassing the router), which is the actual
 *   function containing the bug.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md) — architectural foundation
 *   - /tmp/adr-3524-review-findings.md — architectural justification
 *   - Issue #4 (open-gsd/gsd-core)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup, runGsdTools } = require('./helpers.cjs');

// ── Load cmdPhaseComplete directly from phase.cjs (bypass the SDK router) ────
// phase-command-router.cjs delegates to SDK when available; we must test the
// CJS implementation directly since that is where the bug lives.
const phaseModule = require('../gsd-core/bin/lib/phase.cjs');
const { cmdPhaseComplete } = phaseModule;

// ── Fixture builder ──────────────────────────────────────────────────────────

/**
 * Creates a minimal fixture project with:
 *   - ROADMAP.md with a 4-column progress table (Phase | Plans | Status | Completed)
 *   - REQUIREMENTS.md with a phase-scoped REQ-ID and Traceability row
 *   - STATE.md with Completed Phases: 0 and Total Phases: 2 (Progress 0%)
 *   - Phase 01 directory with one plan+summary (to satisfy phase complete guard)
 *   - Phase 02 directory (next phase)
 */
function createFixture(prefix = 'gsd-4-regression-') {
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
  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  // Phase 02 directory (needed for "next phase" detection)
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

function readStateMd(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
}

function roadmapCompletionSnapshot(roadmapContent) {
  const snapshot = {
    phaseCheckboxes: [],
    progressRows: [],
  };

  for (const line of roadmapContent.split(/\r?\n/)) {
    let match = line.match(/^- \[([ x])\] Phase ([^:]+): (.*)$/);
    if (match) {
      snapshot.phaseCheckboxes.push({
        checked: match[1] === 'x',
        phase: match[2].trim(),
        title: match[3].replace(/\s+\(completed [^)]+\)$/, '').trim(),
      });
      continue;
    }

    match = line.match(/^\|\s*(\d+[A-Z]?(?:\.\d+)*)\.?\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|$/i);
    if (match) {
      snapshot.progressRows.push({
        phase: match[1].trim(),
        title: match[2].trim(),
        plans: match[3].trim(),
        status: match[4].trim(),
        completed: match[5].trim(),
      });
    }
  }

  return snapshot;
}

function extractField(stateContent, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boldMatch = stateContent.match(new RegExp(`\\*\\*${escaped}:\\*\\*[ \\t]*(.+)`, 'i'));
  if (boldMatch) return boldMatch[1].trim();
  const plainMatch = stateContent.match(new RegExp(`^${escaped}:[ \\t]*(.+)`, 'im'));
  return plainMatch ? plainMatch[1].trim() : null;
}

function extractFrontmatterField(stateContent, fieldName) {
  // Extract from YAML frontmatter block
  const fmMatch = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  // Handle both scalar and nested (progress.completed_phases)
  const parts = fieldName.split('.');
  if (parts.length === 1) {
    const m = fm.match(new RegExp(`^${parts[0]}:\\s*(.+)`, 'm'));
    return m ? m[1].trim() : null;
  }
  // Nested: e.g. "progress.completed_phases"
  const sectionMatch = fm.match(new RegExp(`^${parts[0]}:\\s*\\n([\\s\\S]*?)(?=\\n[a-z]|$)`, 'm'));
  if (!sectionMatch) return null;
  const sectionContent = sectionMatch[1];
  const fieldMatch = sectionContent.match(new RegExp(`^\\s+${parts[1]}:\\s*(.+)`, 'm'));
  return fieldMatch ? fieldMatch[1].trim() : null;
}

// Capture stdout from cmdPhaseComplete (it calls output() which writes to stdout)
function capturePhaseComplete(cwd, phaseNum) {
  // We invoke gsd-tools directly for the full CJS path, but with GSD_DISABLE_SDK_BRIDGE=1
  // to force the CJS implementation. Since no env var disables bridge, we call cmdPhaseComplete
  // directly and redirect output capture.
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  process.stderr.write = () => true;
  try {
    cmdPhaseComplete(cwd, phaseNum, false);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
  return chunks.join('');
}

// ── T1: Double invocation must NOT double-increment Completed Phases ─────────

describe('issue #4 (CJS): cmdPhaseComplete — idempotency (blind-increment bug)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('T1: double invocation does NOT double-increment Completed Phases in STATE.md body', () => {
    // First call — legitimate completion
    capturePhaseComplete(tmpDir, '1');

    const stateAfter1 = readStateMd(tmpDir);
    const completedAfter1Body = extractField(stateAfter1, 'Completed Phases');
    const completedAfter1Fm = extractFrontmatterField(stateAfter1, 'progress.completed_phases');
    // After first call: Completed Phases in the body should be 1
    // (derived from ROADMAP: 1 Complete row after marking phase 01 complete)
    // OR the YAML frontmatter completed_phases should be 1
    const completedAfter1 = completedAfter1Body || completedAfter1Fm;
    assert.equal(
      completedAfter1,
      '1',
      `After first call: completed_phases should be 1.\n` +
      `Body field: ${completedAfter1Body}, FM field: ${completedAfter1Fm}\n\n` +
      `STATE:\n${stateAfter1}`,
    );

    // Second call on the same phase — must be idempotent
    capturePhaseComplete(tmpDir, '1');

    const stateAfter2 = readStateMd(tmpDir);
    const completedAfter2Body = extractField(stateAfter2, 'Completed Phases');
    const completedAfter2Fm = extractFrontmatterField(stateAfter2, 'progress.completed_phases');
    const completedAfter2 = completedAfter2Body || completedAfter2Fm;

    // Pre-fix: completedAfter2 would be "2" (blind increment: 1+1=2)
    // Post-fix: must remain "1" (derived from ROADMAP)
    assert.equal(
      completedAfter2,
      '1',
      `T1 FAILED: Completed Phases was double-incremented.\n` +
      `After first call: ${completedAfter1}, after second call: ${completedAfter2}.\n` +
      `This is the #4 non-idempotency bug — blind parseInt+1 instead of deriving from ROADMAP.\n\n` +
      `STATE after second call (body: ${completedAfter2Body}, fm: ${completedAfter2Fm}):\n${stateAfter2}`,
    );
  });

  test('rolls back ROADMAP when STATE write fails during phase completion', (t) => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const originalRoadmap = fs.readFileSync(roadmapPath, 'utf8');
    const originalReq = fs.readFileSync(reqPath, 'utf8');
    const originalState = fs.readFileSync(statePath, 'utf8');
    const originalWriteFileSync = fs.writeFileSync;

    t.mock.method(fs, 'writeFileSync', function injectedStateWriteFailure(target, ...args) {
      const targetPath = String(target);
      const isStatePublish = targetPath === statePath || targetPath === `${statePath}.tmp.${process.pid}`;
      if (isStatePublish) {
        const err = new Error('injected STATE.md write failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFileSync.call(this, target, ...args);
    });

    assert.throws(
      () => capturePhaseComplete(tmpDir, '1'),
      /injected STATE\.md write failure/,
    );

    const roadmapAfter = fs.readFileSync(roadmapPath, 'utf8');
    const reqAfter = fs.readFileSync(reqPath, 'utf8');
    const stateAfter = fs.readFileSync(statePath, 'utf8');

    assert.deepEqual(
      roadmapCompletionSnapshot(roadmapAfter),
      roadmapCompletionSnapshot(originalRoadmap),
      'ROADMAP.md should roll back to its original completion state',
    );
    assert.equal(reqAfter, originalReq, 'REQUIREMENTS.md should roll back when STATE.md write fails');
    assert.equal(stateAfter, originalState, 'STATE.md should remain unchanged after injected write failure');
  });

  test('rolls back ROADMAP when REQUIREMENTS write fails during phase completion', (t) => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const originalRoadmap = fs.readFileSync(roadmapPath, 'utf8');
    const originalReq = fs.readFileSync(reqPath, 'utf8');
    const originalWriteFileSync = fs.writeFileSync;

    t.mock.method(fs, 'writeFileSync', function injectedRequirementsWriteFailure(target, ...args) {
      const targetPath = String(target);
      if (targetPath === reqPath || targetPath === `${reqPath}.tmp.${process.pid}`) {
        const err = new Error('injected REQUIREMENTS.md write failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFileSync.call(this, target, ...args);
    });

    assert.throws(
      () => capturePhaseComplete(tmpDir, '1'),
      /injected REQUIREMENTS\.md write failure/,
    );

    assert.deepEqual(
      roadmapCompletionSnapshot(fs.readFileSync(roadmapPath, 'utf8')),
      roadmapCompletionSnapshot(originalRoadmap),
      'ROADMAP.md should roll back when the REQUIREMENTS write fails',
    );
    assert.equal(fs.readFileSync(reqPath, 'utf8'), originalReq, 'REQUIREMENTS.md should be unchanged');
  });

  test('reports rollback failure when restoring an earlier planning file fails', (t) => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const originalWriteFileSync = fs.writeFileSync;
    let requirementsWriteFailed = false;

    t.mock.method(fs, 'writeFileSync', function injectedRollbackFailure(target, ...args) {
      const targetPath = String(target);
      if (targetPath === reqPath || targetPath === `${reqPath}.tmp.${process.pid}`) {
        requirementsWriteFailed = true;
        const err = new Error('injected REQUIREMENTS.md write failure');
        err.code = 'EIO';
        throw err;
      }
      if (requirementsWriteFailed && (targetPath === roadmapPath || targetPath === `${roadmapPath}.tmp.${process.pid}`)) {
        const err = new Error('injected ROADMAP.md rollback failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFileSync.call(this, target, ...args);
    });

    assert.throws(
      () => capturePhaseComplete(tmpDir, '1'),
      /injected REQUIREMENTS\.md write failure[\s\S]*WARNING: rollback failed while restoring[\s\S]*injected ROADMAP\.md rollback failure/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: phase complete preserves completion date (#1161)
// Tests drive the REAL handler (cmdPhaseComplete) via the CLI entry point
// `runGsdTools('phase complete <N>')` so the fix in phase.cts is exercised
// end-to-end rather than hitting the roadmap.cjs helper in isolation.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the Completed cell from the progress table row for a given phase number.
 * The Completed column is always the LAST cell, regardless of whether the table is
 * 4-col (Phase | Plans | Status | Completed) or 5-col (Phase | Milestone | Plans | Status | Completed).
 */
function extractCompletedCell(roadmapContent, phaseNum) {
  // Match the full progress table row whose first cell starts with the phase number.
  // Use [^|\n] to avoid crossing line boundaries. Capture everything up to the final '|'.
  const re = new RegExp(`^(\\|\\s*${phaseNum}[^|\\n]*(?:\\|[^|\\n]*)*)\\|\\s*$`, 'm');
  const m = roadmapContent.match(re);
  if (!m) return null;
  // m[1] = '| 01. Foundation | 1/1 | Complete    | 2026-01-01 '
  // Split on '|' → ['', ' 01. Foundation ', ' 1/1 ', ' Complete    ', ' 2026-01-01 ']
  // Drop the leading empty string and take the last element.
  const cells = m[1].split('|').slice(1); // drop leading ''
  return cells[cells.length - 1].trim();
}

/**
 * Build a minimal 4-col ROADMAP project fixture whose Phase 01 row already has
 * the Completed cell set to `existingDate` and Status `Complete`.
 * The phase directory has plan+summary so `phase complete 1` can run.
 *
 * @param {string} existingDate  - value in the Completed cell ('2026-01-01', '-', '   ', etc.)
 * @param {boolean} [alreadyComplete] - if true the checkbox is already checked and status Complete
 */
function create4ColFixture(existingDate, alreadyComplete = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1161-4col-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  const checkbox = alreadyComplete ? '[x]' : '[ ]';
  const checkboxSuffix = alreadyComplete ? ' (completed 2026-01-01)' : '';
  const status = alreadyComplete ? 'Complete    ' : 'Not started';

  const roadmap = [
    '# Roadmap',
    '',
    `- ${checkbox} Phase 01: Foundation${checkboxSuffix}`,
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Plans:** 1/1 plans complete',
    '',
    '### Phase 02: API',
    '**Goal:** Build the API',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    `| 01. Foundation | 1/1 | ${status} | ${existingDate} |`,
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), roadmap);

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
  fs.writeFileSync(path.join(planDir, 'STATE.md'), state);

  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

/**
 * Build a minimal 5-col ROADMAP project fixture (Phase | Milestone | Plans | Status | Completed).
 * Phase 01 row already has Completed cell set to `existingDate`.
 */
function create5ColFixture(existingDate, alreadyComplete = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1161-5col-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  const checkbox = alreadyComplete ? '[x]' : '[ ]';
  const checkboxSuffix = alreadyComplete ? ' (completed 2026-01-01)' : '';
  const status = alreadyComplete ? 'Complete    ' : 'Not started';

  const roadmap = [
    '# Roadmap',
    '',
    `- ${checkbox} Phase 01: Foundation${checkboxSuffix}`,
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Plans:** 1/1 plans complete',
    '',
    '### Phase 02: API',
    '**Goal:** Build the API',
    '',
    '## Progress',
    '',
    '| Phase | Milestone | Plans | Status | Completed |',
    '|-------|-----------|-------|--------|-----------|',
    `| 01. Foundation | v1.0 | 1/1 | ${status} | ${existingDate} |`,
    '| 02. API | v1.0 | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), roadmap);

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
  fs.writeFileSync(path.join(planDir, 'STATE.md'), state);

  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

// Fixed historical instant — will never collide with a real today() in CI.
const PINNED_MS_1161 = Date.parse('2021-03-22T10:00:00.000Z');
const PINNED_DATE_1161 = '2021-03-22';
// Env passed to runGsdTools to pin the clock in the subprocess SUT.
const PINNED_CLOCK_ENV = {
  GSD_TEST_MODE: '1',
  GSD_NOW_MS: String(PINNED_MS_1161),
};

describe('regressions: phase complete preserves completion date (#1161)', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── (a) 4-col: already Complete with a date — repeat phase complete must NOT overwrite ──

  test('#1161 (a): 4-col ROADMAP — repeat `phase complete 1` preserves existing Completed date', () => {
    // Arrange: Row is already Complete with '2026-01-01'.
    tmpDir = create4ColFixture('2026-01-01', true);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run `phase complete 1` via the real CLI handler, clock pinned to PINNED_DATE.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell must still be '2026-01-01', NOT the pinned '2021-03-22'.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      '2026-01-01',
      `#1161 (a) FAILED: repeat phase complete on 4-col table overwrote the existing date.\n` +
      `Expected '2026-01-01', got '${completedCell}'.\n` +
      `Pinned clock was '${PINNED_DATE_1161}' — if that appears the date was overwritten.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (b) 5-col: already Complete with a date — repeat phase complete must NOT overwrite ──

  test('#1161 (b): 5-col ROADMAP — repeat `phase complete 1` preserves existing Completed date', () => {
    // Arrange: 5-col table row is already Complete with '2026-01-01'.
    tmpDir = create5ColFixture('2026-01-01', true);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run `phase complete 1` via the real CLI handler, clock pinned to PINNED_DATE.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell must still be '2026-01-01', NOT the pinned '2021-03-22'.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell5 = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell5,
      '2026-01-01',
      `#1161 (b) FAILED: repeat phase complete on 5-col table overwrote the existing date.\n` +
      `Expected '2026-01-01', got '${completedCell5}'.\n` +
      `Pinned clock was '${PINNED_DATE_1161}' — if that appears the date was overwritten.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (c) First-time completion (placeholder '-') must stamp the pinned date ──

  test('#1161 (c): 4-col ROADMAP — first `phase complete 1` (placeholder date) stamps pinned date', () => {
    // Arrange: Row has '-' as Completed cell and is Not started (never completed).
    tmpDir = create4ColFixture('-', false);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: first-time phase complete.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell is now the pinned date.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161 (c) FAILED: first-time completion should stamp '${PINNED_DATE_1161}', got '${completedCell}'.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (d) Whitespace-only Completed cell is treated as empty and gets stamped ──

  test('#1161 (d): 4-col ROADMAP — whitespace-only Completed cell treated as empty, gets stamped', () => {
    // Arrange: Row has '   ' (spaces) as Completed cell.
    tmpDir = create4ColFixture('   ', false);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: first-time phase complete.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell is now the pinned date (whitespace was treated as empty).
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161 (d) FAILED: whitespace-only Completed cell should be stamped '${PINNED_DATE_1161}', got '${completedCell}'.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (e) Non-date garbage in Completed cell is self-healed and gets re-stamped ──

  test('#1161 (e): 5-col ROADMAP — non-date garbage Completed cell is self-healed and re-stamped', () => {
    // Arrange: 5-col row is already Complete but the Completed cell contains 'TBD'
    // (a non-date garbage value that the old guard would have preserved).
    tmpDir = create5ColFixture('TBD', true);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run `phase complete 1` via the real CLI handler, clock pinned to PINNED_DATE.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: garbage 'TBD' must be replaced with the pinned date (self-heal).
    // Pre-Fix 2: the old guard (existingDate && existingDate !== '-') would preserve 'TBD'.
    // Post-Fix 2: the date-shape guard (/^\d{4}-\d{2}-\d{2}$/) rejects 'TBD' → re-stamps.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161 (e) FAILED: non-date garbage 'TBD' in Completed cell should be self-healed to '${PINNED_DATE_1161}', got '${completedCell}'.\n` +
      `Old guard (non-empty && !== '-') would preserve 'TBD'. New guard must require a date shape.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });
});

// ── T2: Progress percent must never exceed 100% ──────────────────────────────

describe('issue #4 (CJS): cmdPhaseComplete — progress percent clamp', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('T2: Progress percent never exceeds 100 after double invocation', () => {
    tmpDir = createFixture();

    // Pre-load STATE.md with Completed Phases: 1, Total Phases: 1 (already 100%)
    // so that a blind +1 on a second call would yield 200%
    let stateContent = readStateMd(tmpDir);
    stateContent = stateContent.replace('**Completed Phases:** 0', '**Completed Phases:** 1');
    stateContent = stateContent.replace('**Total Phases:** 2', '**Total Phases:** 1');
    stateContent = stateContent.replace('**Progress:** 0%', '**Progress:** 100%');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    // Also update ROADMAP to show just 1 phase total
    const roadmap = [
      '# Roadmap',
      '',
      '- [ ] Phase 01: Foundation',
      '',
      '### Phase 01: Foundation',
      '**Goal:** Build the foundation',
      '**Plans:** 1 plans',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 01. Foundation | 0/1 | Not started | - |',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    // First call
    capturePhaseComplete(tmpDir, '1');
    // Second call — this is the problematic one
    capturePhaseComplete(tmpDir, '1');

    const stateAfterBoth = readStateMd(tmpDir);

    // Check body Progress field
    const progressStr = extractField(stateAfterBoth, 'Progress');
    const fmPercent = extractFrontmatterField(stateAfterBoth, 'progress.percent');

    // Try to extract numeric percent from either source
    const bodyPercentMatch = progressStr && progressStr.match(/(\d+)%/);
    const bodyPercent = bodyPercentMatch ? parseInt(bodyPercentMatch[1], 10) : null;
    const fmPercentNum = fmPercent ? parseInt(fmPercent, 10) : null;

    // At least one of body or frontmatter percent must exist and be ≤ 100
    const anyPercent = bodyPercent ?? fmPercentNum;
    assert.ok(
      anyPercent !== null,
      `T2: Could not find any percent value in STATE.md\n\nSTATE:\n${stateAfterBoth}`,
    );
    assert.ok(
      anyPercent <= 100,
      `T2 FAILED: Progress percent exceeds 100.\n` +
      `Body Progress: "${progressStr}" (${bodyPercent}%), FM percent: ${fmPercentNum}%\n` +
      `This is the #4 unclamped-percent bug — (N+1)/total can exceed 100.\n\n` +
      `STATE:\n${stateAfterBoth}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: issue #1159 — Defect A
// VERIFICATION.md with `previous_status: gaps_found` in the body but
// `status: passed` in frontmatter must NOT emit a "has unresolved gaps" warning.
// The bug: /status: gaps_found/.test(fullContent) matches the substring inside
// `previous_status: gaps_found`, causing a false positive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal project fixture with a VERIFICATION.md file whose
 * frontmatter status is `verFmStatus` and whose body contains `previous_status: gaps_found`.
 * Phase 01 has a plan+summary; Phase 02 exists for next-phase detection.
 */
function createVerificationFixture(verFmStatus) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1159-verif-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Foundation',
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  // No REQUIREMENTS.md intentionally (not needed for this defect check)

  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  // The VERIFICATION.md has the CURRENT status in frontmatter but historical
  // `previous_status: gaps_found` in the body — this is the false-positive trigger.
  fs.writeFileSync(path.join(phase01Dir, '01-VERIFICATION.md'), [
    '---',
    `status: ${verFmStatus}`,
    'phase: "01"',
    '---',
    '',
    '# Verification',
    '',
    '<!-- Historical context from previous run -->',
    'previous_status: gaps_found',
    '',
    '## Summary',
    'All checks passed on re-run.',
    '',
  ].join('\n'));

  return tmpDir;
}

describe('issue #1159 (Defect A): VERIFICATION.md historical metadata must not trigger gap warning', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  test(
    '#1159-A-1: status:passed + previous_status:gaps_found in body → NO "has unresolved gaps" warning',
    () => {
      tmpDir = createVerificationFixture('passed');
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      // The output is JSON; parse and check warnings array
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const gapWarnings = warnings.filter((w) => /unresolved gaps/i.test(w));
      assert.equal(
        gapWarnings.length,
        0,
        `#1159-A-1 FAILED: got false gap warning(s) when frontmatter status=passed.\n` +
        `Warnings: ${JSON.stringify(warnings)}\n` +
        `(The regex /status: gaps_found/ matched 'previous_status: gaps_found' in the body.)`,
      );
    },
  );

  test(
    '#1159-A-2 (boundary): status:gaps_found in frontmatter → DOES emit "has unresolved gaps" warning',
    () => {
      tmpDir = createVerificationFixture('gaps_found');
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const gapWarnings = warnings.filter((w) => /unresolved gaps/i.test(w));
      assert.ok(
        gapWarnings.length > 0,
        `#1159-A-2 FAILED: expected a gap warning when frontmatter status=gaps_found but got none.\n` +
        `Warnings: ${JSON.stringify(warnings)}`,
      );
    },
  );

  test(
    '#1159-A-3 (boundary): status:human_needed in frontmatter → DOES emit "needs human verification" warning',
    () => {
      tmpDir = createVerificationFixture('human_needed');
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const humanWarnings = warnings.filter((w) => /human verification/i.test(w));
      assert.ok(
        humanWarnings.length > 0,
        `#1159-A-3 FAILED: expected human-verification warning when frontmatter status=human_needed.\n` +
        `Warnings: ${JSON.stringify(warnings)}`,
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: issue #1159 — Defect B
// Requirement IDs (e.g. FILE-001) that appear under explicitly deferred/future/v2
// sections in REQUIREMENTS.md must NOT be flagged as "missing from Traceability".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal project fixture with a REQUIREMENTS.md that has:
 * - An active requirement ACTIVE-001 that IS in the Traceability table
 * - A deferred requirement DEFER-001 under a "Deferred v2 Requirements" heading
 *   that is NOT in the Traceability table (correctly out of scope)
 * - Optionally a truly-missing active requirement MISSING-001 (not in table)
 */
function createDeferredReqFixture({ includeMissingActive = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1159-deferred-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  const missingActiveLines = includeMissingActive
    ? ['', '- **MISSING-001** Active req not in traceability table.']
    : [];

  fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), [
    '# Requirements',
    '',
    '## Functional Requirements',
    '',
    '- **ACTIVE-001** Core feature must work.',
    ...missingActiveLines,
    '',
    '## Deferred v2 Requirements',
    '',
    '- **DEFER-001** Nice-to-have for v2, explicitly out of scope.',
    '',
    '## Future Backlog',
    '',
    '- **FUTURE-001** Consider for next major release.',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '| ACTIVE-001 | Phase 01 | Pending |',
    '',
  ].join('\n'));

  // Roadmap references ACTIVE-001 for phase 01
  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Foundation',
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Requirements:** ACTIVE-001',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  return tmpDir;
}

describe('issue #1159 (Defect B): deferred/future requirement IDs must not trigger traceability warning', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  test(
    '#1159-B-1: IDs under "Deferred v2 Requirements" and "Future Backlog" sections → NO traceability warning',
    () => {
      tmpDir = createDeferredReqFixture({ includeMissingActive: false });
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      assert.equal(
        traceWarnings.length,
        0,
        `#1159-B-1 FAILED: got false traceability warning(s) for deferred/future IDs.\n` +
        `Warnings: ${JSON.stringify(warnings)}\n` +
        `(DEFER-001 and FUTURE-001 are under deferred/future sections and must be ignored.)`,
      );
    },
  );

  test(
    '#1159-B-2 (boundary): truly-missing ACTIVE ID (not in table, not in deferred section) → DOES warn',
    () => {
      tmpDir = createDeferredReqFixture({ includeMissingActive: true });
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      assert.ok(
        traceWarnings.length > 0,
        `#1159-B-2 FAILED: expected traceability warning for MISSING-001 (active, not in table) but got none.\n` +
        `Warnings: ${JSON.stringify(warnings)}`,
      );
      // Verify MISSING-001 is specifically mentioned
      const mentionsMissing = traceWarnings.some((w) => w.includes('MISSING-001'));
      assert.ok(
        mentionsMissing,
        `#1159-B-2 FAILED: warning exists but MISSING-001 not mentioned.\n` +
        `Traceability warnings: ${JSON.stringify(traceWarnings)}`,
      );
    },
  );

  test(
    '#1159-B-3 (boundary): deferred IDs must not contaminate warning even when active ID is also missing',
    () => {
      tmpDir = createDeferredReqFixture({ includeMissingActive: true });
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      // DEFER-001 and FUTURE-001 must NOT appear in the traceability warnings
      const mentionsDefer = traceWarnings.some((w) => w.includes('DEFER-001') || w.includes('FUTURE-001'));
      assert.ok(
        !mentionsDefer,
        `#1159-B-3 FAILED: deferred IDs (DEFER-001/FUTURE-001) appeared in traceability warning.\n` +
        `Traceability warnings: ${JSON.stringify(traceWarnings)}`,
      );
    },
  );
});
