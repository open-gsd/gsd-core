'use strict';
// allow-test-rule: reads runtime STATE.md written to temp dir — behavioral output test, not source-grep

// Regression tests for bug #397.
//
// STATE.md fields edited by an executor (e.g. a hand-authored Resume File path,
// a custom Status value, or a custom Last Activity entry) were silently overwritten
// by the next call to record-session, advance-plan, or planned-phase because the
// handlers used unconditional stateReplaceField / stateReplaceFieldWithFallback
// calls, even when the option was not passed by the caller.
//
// Fix: introduce KNOWN_TEMPLATE_DEFAULTS (a per-field table of string values that
// are safe to replace because they came from a template) and
// stateReplaceFieldIfTemplate (a helper that only replaces when the current value
// is a template default or absent). Handlers must consult this table rather than
// writing unconditionally.
//
// The 7 baseline cases verified here:
//
//  1. record-session WITHOUT --resume-file when Resume File is executor-authored
//     → preserved (must NOT be replaced with 'None')
//  2. record-session WITHOUT --resume-file when Resume File is 'None'
//     → remains 'None' (template-default → template-default is fine)
//  3. record-session WITH --resume-file → explicit caller value wins (always)
//  4. advance-plan phase-complete when Status is executor-authored → preserved
//  5. advance-plan phase-complete when Status is a known default → replaced
//  6. advance-plan advance when Last Activity is executor-authored → preserved
//  7. updateCurrentPositionFields with executor-authored Current Position values
//     → preserved

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempPlanning(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-397-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

function readState(dir) {
  return fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
}

function runGsdState(args, cwd) {
  const { execFileSync } = require('child_process');
  const env = {
    ...process.env,
    GSD_SESSION_KEY: '',
    CODEX_THREAD_ID: '',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SSE_PORT: '',
    OPENCODE_SESSION_ID: '',
  };
  try {
    execFileSync(process.execPath, [TOOLS_PATH, 'state', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.stderr?.toString().trim() || err.message };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Case 1: Resume File is executor-authored (not a template default)
const STATE_EXECUTOR_RESUME_FILE = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 4
Current Plan: 1
Status: Ready to execute

## Current Position
Phase: 2
Plan: 1 of 4
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: /home/user/my-custom-context.md
Stopped At: Phase 2 Plan 1 complete
`;

// Case 2: Resume File is 'None' (the known template default)
const STATE_DEFAULT_RESUME_FILE = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 4
Current Plan: 1
Status: Ready to execute

## Current Position
Phase: 2
Plan: 1 of 4
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
Stopped At: Phase 2 Plan 1 complete
`;

// Cases 4 & 7: Status is executor-authored in both Configuration and Current Position.
// Current Plan=2, Total Plans=2 → triggers the phase-complete branch of advance-plan.
const STATE_EXECUTOR_STATUS = `# GSD State

## Configuration
Current Phase: 3
Total Plans in Phase: 2
Current Plan: 2
Status: Awaiting QA sign-off before proceeding

## Current Position
Phase: 3
Plan: 2 of 2
Status: Awaiting QA sign-off before proceeding
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 5: Status IS a known template default ('Ready to execute').
// Current Plan=2, Total Plans=2 → triggers the phase-complete branch.
const STATE_DEFAULT_STATUS = `# GSD State

## Configuration
Current Phase: 3
Total Plans in Phase: 2
Current Plan: 2
Status: Ready to execute

## Current Position
Phase: 3
Plan: 2 of 2
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 6: The only Last Activity field in the document is executor-authored
// (a narrative, not a bare ISO date). Current Plan=1, Total=3 → advance branch.
const STATE_EXECUTOR_LAST_ACTIVITY = `# GSD State

## Configuration
Current Phase: 2
Total Plans in Phase: 3
Current Plan: 1
Status: Ready to execute
Last Activity: Unblocked after infra fix — merged PR #88 manually

## Current Position
Phase: 2
Plan: 1 of 3
Status: Ready to execute
Last activity: 2026-01-01

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// Case 7: Current Position has executor-authored Status and Last activity.
// Current Plan=2, Total=3 → advance branch.
const STATE_EXECUTOR_CURRENT_POSITION = `# GSD State

## Configuration
Current Phase: 4
Total Plans in Phase: 3
Current Plan: 2
Status: Ready to execute

## Current Position
Phase: 4
Plan: 2 of 3
Status: On hold — waiting for upstream dependency merge
Last activity: 2026-02-15 -- blocked by infra; resume after merge

## Session Continuity
Last session: 2026-01-01T00:00:00.000Z
Last Date: 2026-01-01T00:00:00.000Z
Resume File: None
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #397: executor-authored STATE.md fields must be preserved', () => {

  // Case 1: record-session without --resume-file, Resume File is executor-authored
  test('case 1: record-session without --resume-file preserves executor-authored Resume File', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--stopped-at', 'Plan 1 complete'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const rfMatch = after.match(/Resume File:\s*(.+)/i);
      assert.ok(rfMatch, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        rfMatch[1].trim(),
        '/home/user/my-custom-context.md',
        `record-session overwrote executor-authored Resume File with '${rfMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 2: record-session without --resume-file, Resume File is 'None' (template default)
  test('case 2: record-session without --resume-file keeps "None" when it is already "None"', () => {
    const dir = makeTempPlanning(STATE_DEFAULT_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--stopped-at', 'Plan complete'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const rfMatch = after.match(/Resume File:\s*(.+)/i);
      assert.ok(rfMatch, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        rfMatch[1].trim(),
        'None',
        `Expected 'None' to remain when it was already 'None', got: ${rfMatch[1].trim()}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 3: record-session WITH --resume-file — explicit value always wins
  test('case 3: record-session with --resume-file sets the explicit value', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_RESUME_FILE);
    try {
      const r = runGsdState(['record-session', '--resume-file', '/tmp/new-resume.md'], dir);
      assert.ok(r.success, `record-session failed: ${r.error}`);
      const after = readState(dir);
      const rfMatch = after.match(/Resume File:\s*(.+)/i);
      assert.ok(rfMatch, 'Resume File field not found in STATE.md after record-session');
      assert.strictEqual(
        rfMatch[1].trim(),
        '/tmp/new-resume.md',
        `Expected explicit --resume-file value to be written, got: ${rfMatch[1].trim()}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 4: advance-plan phase-complete, Status is executor-authored → preserved
  test('case 4: advance-plan (phase-complete) preserves executor-authored Status', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_STATUS);
    try {
      // Current Plan=2, Total=2 → phase-complete branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // The Configuration-level Status must not be clobbered
      const statusMatch = after.match(/^Status:\s*(.+)/m);
      assert.ok(statusMatch, 'Status field not found after advance-plan');
      assert.strictEqual(
        statusMatch[1].trim(),
        'Awaiting QA sign-off before proceeding',
        `advance-plan overwrote executor-authored Status: got '${statusMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 5: advance-plan phase-complete, Status is a known default → replaced
  test('case 5: advance-plan (phase-complete) replaces known-default Status with phase-complete value', () => {
    const dir = makeTempPlanning(STATE_DEFAULT_STATUS);
    try {
      // Current Plan=2, Total=2 → phase-complete branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      const statusMatch = after.match(/^Status:\s*(.+)/m);
      assert.ok(statusMatch, 'Status field not found after advance-plan');
      // 'Ready to execute' is a known default and should be replaced
      assert.notStrictEqual(
        statusMatch[1].trim(),
        'Ready to execute',
        `Status should have been updated from 'Ready to execute' after phase-complete, but was not`,
      );
      assert.ok(
        statusMatch[1].includes('Phase complete') || statusMatch[1].includes('ready for verification'),
        `Expected phase-complete Status text, got: '${statusMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 6: advance-plan normal advance, top-level Last Activity is executor-authored → preserved
  test('case 6: advance-plan (normal advance) preserves executor-authored Last Activity', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_LAST_ACTIVITY);
    try {
      // Current Plan=1, Total=3 → advance branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      // The top-level Last Activity (in Configuration section) must be preserved
      const laMatch = after.match(/^Last Activity:\s*(.+)/im);
      assert.ok(laMatch, 'Last Activity field not found after advance-plan');
      assert.strictEqual(
        laMatch[1].trim(),
        'Unblocked after infra fix — merged PR #88 manually',
        `advance-plan overwrote executor-authored Last Activity: got '${laMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // Case 7: advance-plan preserves executor-authored Status and Last activity in Current Position
  test('case 7: advance-plan preserves executor-authored Current Position Status and Last activity', () => {
    const dir = makeTempPlanning(STATE_EXECUTOR_CURRENT_POSITION);
    try {
      // Current Plan=2, Total=3 → advance branch
      const r = runGsdState(['advance-plan'], dir);
      assert.ok(r.success, `advance-plan failed: ${r.error}`);
      const after = readState(dir);
      const posMatch = after.match(/##\s*Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
      assert.ok(posMatch, 'Current Position section not found after advance-plan');
      const posBody = posMatch[1];
      const posStatusMatch = posBody.match(/^Status:\s*(.+)/m);
      assert.ok(posStatusMatch, 'Status field not found in Current Position section');
      assert.strictEqual(
        posStatusMatch[1].trim(),
        'On hold — waiting for upstream dependency merge',
        `advance-plan overwrote executor-authored Current Position Status: got '${posStatusMatch[1].trim()}'`,
      );
      const posActivityMatch = posBody.match(/^Last activity:\s*(.+)/im);
      assert.ok(posActivityMatch, 'Last activity field not found in Current Position section');
      assert.ok(
        posActivityMatch[1].includes('blocked by infra'),
        `advance-plan overwrote executor-authored Current Position Last activity: got '${posActivityMatch[1].trim()}'`,
      );
    } finally {
      cleanup(dir);
    }
  });

});
