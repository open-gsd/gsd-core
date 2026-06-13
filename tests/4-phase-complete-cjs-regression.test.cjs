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

const { cleanup } = require('./helpers.cjs');

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

// ── Load cmdRoadmapUpdatePlanProgress for #1161 regression tests ─────────────
const roadmapModule = require('../gsd-core/bin/lib/roadmap.cjs');
const { cmdRoadmapUpdatePlanProgress } = roadmapModule;

/**
 * Capture stdout from cmdRoadmapUpdatePlanProgress (same pattern as capturePhaseComplete).
 */
function captureRoadmapUpdatePlanProgress(cwd, phaseNum) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  process.stderr.write = () => true;
  try {
    cmdRoadmapUpdatePlanProgress(cwd, phaseNum, false);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
  return chunks.join('');
}

/**
 * Build a minimal project fixture whose ROADMAP already has the Completed cell
 * set to `existingDate`. Useful for #1161 idempotency tests.
 *
 * @param {string} existingDate  - value to place in the Completed cell (e.g. '2026-01-01' or '-')
 * @param {string} [prefix]
 */
function createRoadmapDateFixture(existingDate, prefix = 'gsd-1161-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  const roadmap = [
    '# Roadmap',
    '',
    '- [x] Phase 01: Foundation (completed 2026-01-01)',
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
    `| 01. Foundation | 1/1 | Complete    | ${existingDate} |`,
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap);

  const state = [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Completed Phases:** 1',
    '**Total Phases:** 2',
    '**Progress:** 50%',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), state);

  // Phase 01 directory with plan + summary (already complete)
  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  // Phase 02 directory (incomplete)
  const phase02Dir = path.join(phasesDir, '02-api');
  fs.mkdirSync(phase02Dir, { recursive: true });
  fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan 2\nBuild API.\n');

  return tmpDir;
}

/** Extract the Completed cell from the progress table row for a given phase number. */
function extractCompletedCell(roadmapContent, phaseNum) {
  // Match progress table rows like: | 01. Foundation | 1/1 | Complete    | 2026-01-01 |
  const re = new RegExp(`^\\|\\s*${phaseNum}[^|]*\\|[^|]*\\|[^|]*\\|([^|]*)\\|`, 'm');
  const m = roadmapContent.match(re);
  return m ? m[1].trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: phase complete preserves completion date (#1161)
// ─────────────────────────────────────────────────────────────────────────────

// Fixed historical instant — will never collide with a real today() in CI.
const PINNED_MS_1161 = Date.parse('2021-03-22T10:00:00.000Z');
const PINNED_DATE_1161 = '2021-03-22';

describe('regressions: phase complete preserves completion date (#1161)', () => {
  let tmpDir;
  let _origTestMode;
  let _origNowMs;

  beforeEach(() => {
    // Pin the clock so any newly-written date is deterministic and
    // distinguishable from the pre-existing '2026-01-01' fixture date.
    _origTestMode = process.env.GSD_TEST_MODE;
    _origNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
    process.env.GSD_NOW_MS = String(PINNED_MS_1161);
  });

  afterEach(() => {
    // Restore env vars to avoid polluting other tests.
    if (_origTestMode === undefined) {
      delete process.env.GSD_TEST_MODE;
    } else {
      process.env.GSD_TEST_MODE = _origTestMode;
    }
    if (_origNowMs === undefined) {
      delete process.env.GSD_NOW_MS;
    } else {
      process.env.GSD_NOW_MS = _origNowMs;
    }
    cleanup(tmpDir);
  });

  test('#1161: re-running roadmap update-plan-progress on an already-Complete row preserves existing date', () => {
    // Arrange: ROADMAP row is already Complete with a specific date from the past.
    tmpDir = createRoadmapDateFixture('2026-01-01');
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run update-plan-progress again (simulating a repeat `phase complete 1` call).
    captureRoadmapUpdatePlanProgress(tmpDir, '1');

    // Assert: the Completed cell must still be '2026-01-01', NOT the pinned clock date.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');

    assert.strictEqual(
      completedCell,
      '2026-01-01',
      `#1161 FAILED: repeat phase complete rewrote existing date.\n` +
      `Expected '2026-01-01', got '${completedCell}'.\n` +
      `Pinned clock date was '${PINNED_DATE_1161}' — if that appears, the date was overwritten.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  test('#1161: completing a phase for the FIRST TIME (empty/placeholder date) stamps the pinned clock date', () => {
    // Arrange: ROADMAP row has placeholder '-' in Completed cell (not yet completed).
    // But the phase 01 directory already has plan+summary, so it IS complete.
    // We use a fresh fixture where the Completed cell is '-'.
    tmpDir = createRoadmapDateFixture('-');
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Override the ROADMAP status to "Not started" so it hasn't been stamped yet.
    let roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
    roadmapContent = roadmapContent.replace(
      /\| 01\. Foundation \| 1\/1 \| Complete\s*\| - \|/,
      '| 01. Foundation | 0/1 | Not started | - |',
    );
    // Also clear the checkbox to unchecked
    roadmapContent = roadmapContent.replace(
      /- \[x\] Phase 01: Foundation \(completed [^)]+\)/,
      '- [ ] Phase 01: Foundation',
    );
    fs.writeFileSync(roadmapPath, roadmapContent);

    // Act: run update-plan-progress (phase 01 has 1 plan + 1 summary → Complete).
    captureRoadmapUpdatePlanProgress(tmpDir, '1');

    // Assert: the Completed cell must now be PINNED_DATE_1161.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');

    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161: first completion should stamp the clock date.\n` +
      `Expected '${PINNED_DATE_1161}', got '${completedCell}'.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  test('#1161: whitespace-only Completed cell is treated as empty and gets stamped', () => {
    // Arrange: Completed cell is whitespace-only (some editors leave spaces).
    tmpDir = createRoadmapDateFixture('   ');
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    // Override status to ensure row is currently not-complete so the stamp fires.
    let roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
    roadmapContent = roadmapContent.replace(
      '| 01. Foundation | 1/1 | Complete    |    |',
      '| 01. Foundation | 0/1 | Not started |    |',
    );
    roadmapContent = roadmapContent.replace(
      /- \[x\] Phase 01: Foundation \(completed [^)]+\)/,
      '- [ ] Phase 01: Foundation',
    );
    fs.writeFileSync(roadmapPath, roadmapContent);

    captureRoadmapUpdatePlanProgress(tmpDir, '1');

    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');

    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161: whitespace-only Completed cell should be stamped on first completion.\n` +
      `Expected '${PINNED_DATE_1161}', got '${completedCell}'.\n\n` +
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
