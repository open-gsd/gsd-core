'use strict';

/**
 * Regression test for issue #4 (open-gsd/get-shit-done-redux):
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
 *   - Issue #4 (open-gsd/get-shit-done-redux)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Load cmdPhaseComplete directly from phase.cjs (bypass the SDK router) ────
// phase-command-router.cjs delegates to SDK when available; we must test the
// CJS implementation directly since that is where the bug lives.
const phaseModule = require('../get-shit-done/bin/lib/phase.cjs');
const { cmdPhaseComplete } = phaseModule;

// ── Fixture builder ──────────────────────────────────────────────────────────

/**
 * Creates a minimal fixture project with:
 *   - ROADMAP.md with a 4-column progress table (Phase | Plans | Status | Completed)
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
  const { execFileSync } = require('child_process');
  const TOOLS = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-tools.cjs');
  // We invoke gsd-tools directly for the full CJS path, but with GSD_DISABLE_SDK_BRIDGE=1
  // to force the CJS implementation. Since no env var disables bridge, we call cmdPhaseComplete
  // directly and redirect output capture.
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    cmdPhaseComplete(cwd, phaseNum, false);
  } finally {
    process.stdout.write = origWrite;
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});

// ── T2: Progress percent must never exceed 100% ──────────────────────────────

describe('issue #4 (CJS): cmdPhaseComplete — progress percent clamp', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
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
