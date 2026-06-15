'use strict';
// allow-test-rule: reads runtime STATE.md written to temp dir — behavioral output test, not source-grep — see #1255

/**
 * Regression tests for bug #1255.
 *
 * `state begin-phase` / `state complete-phase` do not advance the frontmatter
 * `status` when the body `Status` field is expressed as a pipe-table row
 * (`| Status | Planning |`) instead of an inline key-value pair
 * (`Status: Planning`).
 *
 * Root cause: `stateReplaceField(content, 'Status', ...)` is called with the
 * full file content (frontmatter + body). The plain-text pattern
 * (`^Status:\s*(.+)` with /im flag) matches `status: planning` in the YAML
 * frontmatter block rather than the body pipe-table row. The pipe-table row
 * is never updated. `syncStateFrontmatter` then re-derives from the body (which
 * still says 'Planning') and the #1230 delta heuristic preserves the old
 * frontmatter value ('planning'), so the status never advances to 'executing'.
 *
 * Fix: strip frontmatter before all body-field replacements in
 * `cmdStateBeginPhase` and `cmdStateCompletePhase`, then reassemble.
 *
 * Additional bugs fixed (#1255 follow-up):
 * 1. complete-phase Phase table cell had label-duplication: `Phase: 1 — COMPLETE`
 *    instead of bare `1 — COMPLETE`.
 * 2. begin-phase and complete-phase Last-activity table branches wrote bare date
 *    instead of date + narrative (inconsistent with inline branch).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGsdTools, cleanup } = require('./helpers.cjs');

function makeTempProject(stateContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1255-'));
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  // Minimal ROADMAP so buildStateFrontmatter can resolve phase counts
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), [
    '# ROADMAP',
    '',
    '## Phase 1: setup:',
    '- [ ] Step 1',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf8');
  return dir;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// STATE.md where Status lives entirely in pipe-table rows (no inline "Status: ..." anywhere)
// This is the form a hand-edited or legacy STATE.md might use, and is a
// supported body format (do NOT silently rewrite to inline).
const TABLE_STATUS_PLANNING = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 1 |
| Status | Planning |
| Last Activity | 2026-06-01 |
| Last Activity Description | Roadmap created |

## Current Position

| Phase | 1 (setup) |
| Plan | 1 of 3 |
| Status | Planning |
| Last activity | 2026-06-01 |
`;

// STATE.md with Status as pipe-table but execution already in progress (complete-phase scenario)
const TABLE_STATUS_EXECUTING = `---
gsd_state_version: '1.0'
status: executing
---

# Project State

## Configuration

| Current Phase | 1 |
| Current Phase Name | setup |
| Total Plans in Phase | 3 |
| Current Plan | 3 |
| Status | Executing Phase 1 |
| Last Activity | 2026-06-01 |
| Last Activity Description | Phase 1 execution started |

## Current Position

| Phase | 1 (setup) |
| Plan | 3 of 3 |
| Status | Executing Phase 1 |
| Last activity | 2026-06-01 |
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('bug #1255: state begin-phase / complete-phase with pipe-table Status', () => {
  // begin-phase: planning → executing
  test('begin-phase advances frontmatter status planning→executing when body Status is pipe-table', () => {
    const dir = makeTempProject(TABLE_STATUS_PLANNING);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Primary assertion: frontmatter status must advance to 'executing'
      const fmMatch = after.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after begin-phase');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `frontmatter status must be 'executing' after begin-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // begin-phase: body pipe-table row must also be updated
  test('begin-phase updates body pipe-table Status cell to Executing Phase N', () => {
    const dir = makeTempProject(TABLE_STATUS_PLANNING);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      // The pipe-table Status cell in the Configuration table must be updated
      assert.ok(
        /\|\s*Status\s*\|\s*Executing Phase 1\s*\|/i.test(after),
        `body pipe-table Status cell must be updated to 'Executing Phase 1'; got:\n${after}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // begin-phase: Current Position table cells — exact cell values
  test('begin-phase updates Current Position pipe-table Status and Last activity cells correctly', () => {
    const dir = makeTempProject(TABLE_STATUS_PLANNING);
    try {
      runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Current Position section only, to avoid matching Configuration rows
      const cpMatch = after.match(/##\s*Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // Status cell in Current Position: bare value, not prefixed
      assert.ok(
        /\|\s*Status\s*\|\s*Executing Phase 1\s*\|/i.test(cpSection),
        `Current Position Status cell must be 'Executing Phase 1'; got Current Position:\n${cpSection}`
      );

      // Last activity cell must include date + narrative (not bare date)
      assert.ok(
        /\|\s*Last activity\s*\|[^|]*--\s*Phase 1 execution started\s*\|/i.test(cpSection),
        `Current Position Last activity cell must include narrative '-- Phase 1 execution started'; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: executing → completed
  test('complete-phase advances frontmatter status executing→completed when body Status is pipe-table', () => {
    const dir = makeTempProject(TABLE_STATUS_EXECUTING);
    try {
      const result = runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      assert.ok(result.success, `complete-phase failed: ${result.error || result.output}`);

      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Primary assertion: frontmatter status must be 'completed'
      const fmMatch = after.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fmMatch, 'STATE.md must have YAML frontmatter after complete-phase');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*completed\s*$/m.test(fm),
        `frontmatter status must be 'completed' after complete-phase on pipe-table STATUS; got frontmatter:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: body pipe-table row must also be updated
  test('complete-phase updates body pipe-table Status cell to Phase N complete', () => {
    const dir = makeTempProject(TABLE_STATUS_EXECUTING);
    try {
      runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      assert.ok(
        /\|\s*Status\s*\|\s*Phase 1 complete\s*\|/i.test(after),
        `body pipe-table Status cell must be updated to 'Phase 1 complete'; got:\n${after}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // complete-phase: Current Position table cells — exact cell values (catches bugs 1 and 2)
  test('complete-phase updates Current Position pipe-table Phase/Status/Last-activity cells correctly', () => {
    const dir = makeTempProject(TABLE_STATUS_EXECUTING);
    try {
      runGsdTools(
        ['state', 'complete-phase', '--phase', '1'],
        dir
      );
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');

      // Extract the ## Current Position section only, to avoid matching Configuration rows
      const cpMatch = after.match(/##\s*Current Position\s*\n([\s\S]*?)(?=\n##|$)/i);
      assert.ok(cpMatch, '## Current Position section must exist');
      const cpSection = cpMatch[1];

      // Bug 1: Phase cell must be bare '1 — COMPLETE', NOT 'Phase: 1 — COMPLETE'
      assert.ok(
        /\|\s*Phase\s*\|\s*1\s*—\s*COMPLETE\s*\|/.test(cpSection),
        `Current Position Phase cell must be '1 — COMPLETE' (no 'Phase:' prefix in cell value); got Current Position:\n${cpSection}`
      );
      assert.ok(
        !/\|\s*Phase\s*\|\s*Phase:\s*1/.test(cpSection),
        `Current Position Phase cell must NOT contain 'Phase: 1' (label-duplication bug); got Current Position:\n${cpSection}`
      );

      // Status cell in Current Position: bare value
      assert.ok(
        /\|\s*Status\s*\|\s*Phase 1 complete\s*\|/i.test(cpSection),
        `Current Position Status cell must be 'Phase 1 complete'; got Current Position:\n${cpSection}`
      );

      // Bug 2: Last activity cell must include date + narrative (not bare date)
      assert.ok(
        /\|\s*Last activity\s*\|[^|]*--\s*Phase 1 marked complete\s*\|/i.test(cpSection),
        `Current Position Last activity cell must include narrative '-- Phase 1 marked complete'; got Current Position:\n${cpSection}`
      );
    } finally {
      cleanup(dir);
    }
  });

  // Regression guard: inline Status format must still work (existing behavior unchanged)
  test('begin-phase still works correctly with inline Status: format (regression guard)', () => {
    const inlineStateMd = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

Current Phase: 1
Current Phase Name: setup
Total Plans in Phase: 3
Current Plan: 1
Status: Planning
Last Activity: 2026-06-01
Last Activity Description: Roadmap created

## Current Position
Phase: 1 (setup)
Plan: 1 of 3
Status: Planning
Last activity: 2026-06-01 -- Roadmap created
`;
    const dir = makeTempProject(inlineStateMd);
    try {
      const result = runGsdTools(
        ['state', 'begin-phase', '--phase', '1', '--name', 'setup', '--plans', '3'],
        dir
      );
      assert.ok(result.success, `begin-phase failed on inline format: ${result.error || result.output}`);
      const after = fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8');
      const fmMatch = after.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(fmMatch, 'must have frontmatter');
      const fm = fmMatch[1];
      assert.ok(
        /^status:\s*executing\s*$/m.test(fm),
        `inline Status: format: frontmatter status must be 'executing'; got:\n${fm}`
      );
    } finally {
      cleanup(dir);
    }
  });
});
