'use strict';
// Regression tests for issue #1162 — STATE.md table-format field read/replace.
//
// STATE.md "Current Position" sections may render as pipe tables:
//
//   | Status | Ready to plan |
//   | Phase  | 3             |
//
// stateReplaceField and stateExtractField must detect the VALUE CELL of a
// `| Field | value |` row and read/replace it, while treating the separator
// row `| --- | --- |` as NOT a field.  The `state update` command must return
// { updated: true } and the table cell must be rewritten on disk.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal STATE.md that uses a pipe-table for the Current Position section.
 * This is the format that triggered the "Field not found" silent failure.
 */
function buildTableFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
    planCount = '4',
    lastActivity = '2026-01-01',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${status} |`,
    `| Phase | ${phase} |`,
    `| Total Plans in Phase | ${planCount} |`,
    `| Last Activity | ${lastActivity} |`,
    '',
    '## Accumulated Context',
    '',
    'Some context here.',
    '',
  ].join('\n');
}

/**
 * STATE.md that uses bold inline format (the existing working format).
 * Included as a control case to confirm we did not break bold-field support.
 */
function buildBoldFormatState(opts) {
  const {
    status = 'Ready to plan',
    phase = '3',
  } = opts || {};

  return [
    '---',
    'gsd_state_version: 1.0',
    'status: planning',
    '---',
    '',
    '# GSD State',
    '',
    '## Current Position',
    '',
    `**Status:** ${status}`,
    `**Phase:** ${phase}`,
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1162: state update on table-format STATE.md', () => {
  let tmpDir;
  let statePath;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-1162-');
    statePath = path.join(tmpDir, '.planning', 'STATE.md');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Happy path: table-format field replacement ──────────────────────────

  test('state update rewrites table-cell Status value', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    // Command must report success
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true but got: ' + JSON.stringify(parsed));

    // The table cell must be rewritten on disk
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'Table cell not rewritten. STATE.md content:\n' + written,
    );
    // Original value must be gone
    assert.ok(
      !written.includes('| Status | Ready to plan |'),
      'Old table cell value still present in STATE.md',
    );
  });

  test('state update rewrites table-cell value for arbitrary field', () => {
    fs.writeFileSync(statePath, buildTableFormatState({ lastActivity: '2026-01-01' }));

    const result = runGsdTools(['state', 'update', 'Last Activity', '2026-06-13'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'expected updated:true');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('| Last Activity | 2026-06-13 |'),
      'Last Activity table cell not rewritten. Content:\n' + written,
    );
  });

  test('state update is case-insensitive for table field names', () => {
    // Table may have lowercase "status" in the first cell
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| status | Ready to plan |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'case-insensitive table match failed');
  });

  // ── Negative: separator row must NOT be treated as a field ───────────────

  test('separator row | --- | --- | is not matched as a field', () => {
    // The field name "---" is rejected by the field-name validator before
    // stateReplaceField is even called.  The command exits with a non-zero
    // status and a plain-text error, NOT a JSON { updated: false } result.
    // The key invariant is that the file is never corrupted.
    const originalContent = buildTableFormatState();
    fs.writeFileSync(statePath, originalContent);

    const result = runGsdTools(['state', 'update', '---', 'injected'], tmpDir);

    // The validator rejects '---' as an invalid field name — command must fail
    // OR, if somehow the command succeeds, updated must be false.
    if (result.success) {
      // Unlikely path — if the validator is relaxed in future, still must not update.
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { parsed = null; }
      if (parsed) {
        assert.equal(parsed.updated, false, 'separator row incorrectly matched as a field');
      }
    }
    // Either way: the file must be untouched (no 'injected' value written)
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(!written.includes('injected'), 'separator row replacement leaked into file');
  });

  // ── Regression: bold-format still works after the fix ────────────────────

  test('state update bold-format still works after table support added', () => {
    fs.writeFileSync(statePath, buildBoldFormatState({ status: 'Ready to plan' }));

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'bold-format update broken after fix');

    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(
      written.includes('**Status:** Ready to execute'),
      'Bold-format field not rewritten. Content:\n' + written,
    );
  });

  // ── updateCurrentPositionFields table support ─────────────────────────────

  test('state planned-phase updates table-cell Status via updateCurrentPositionFields', () => {
    // cmdStatePlannedPhase uses updateCurrentPositionFields internally;
    // verify it also handles the table format.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      'status: planning',
      '---',
      '',
      '# GSD State',
      '',
      '**Status:** Ready to plan',
      '**Total Plans in Phase:** 0',
      '**Last Activity:** 2026-01-01',
      '**Last Activity Description:** initial',
      '',
      '## Current Position',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Status | Ready to plan |',
      '| Last Activity | 2026-01-01 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Create a minimal phase dir so planned-phase can count plans
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '1-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '1-01-PLAN.md'), '# Plan 1');

    const result = runGsdTools(['state', 'planned-phase', '1', '--plan-count', '1'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);

    const written = fs.readFileSync(statePath, 'utf-8');
    // The Current Position table cell should now be "Ready to execute"
    assert.ok(
      written.includes('| Status | Ready to execute |'),
      'planned-phase did not update table-cell Status. Content:\n' + written,
    );
  });

  // ── Adversarial / edge cases ──────────────────────────────────────────────

  test('table field with extra whitespace in cells is handled', () => {
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '|  Status  |  Ready to plan  |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'extra-whitespace table cell not matched');
  });

  test('updating one row in a multi-row table does not corrupt adjacent rows', () => {
    // Regression: updating `Status` must leave the `Phase` row untouched.
    // NOTE: values containing literal '|' (e.g., "blocked | waiting") are NOT
    // supported — the current value regex [^|\n]*? stops at the first pipe.
    // Escaped-pipe values are out of scope for single-token status fields.
    const content = [
      '---',
      'gsd_state_version: 1.0',
      '---',
      '',
      '## Current Position',
      '',
      '| Status | Ready to plan |',
      '| Phase | 3 |',
      '',
    ].join('\n');
    fs.writeFileSync(statePath, content);

    // Normal replacement — verify Phase row is untouched
    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const written = fs.readFileSync(statePath, 'utf-8');
    assert.ok(written.includes('| Phase | 3 |'), 'Phase row was corrupted during Status update');
  });

  test('CRLF line endings in table format are handled', () => {
    const content = buildTableFormatState({ status: 'Ready to plan' }).replace(/\n/g, '\r\n');
    fs.writeFileSync(statePath, content);

    const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], tmpDir);

    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.updated, true, 'CRLF table format not handled');
  });

  test('missing STATE.md returns updated:false gracefully', () => {
    // No STATE.md written — verify the command does not throw
    const missingDir = createTempProject('gsd-1162-missing-');
    try {
      const result = runGsdTools(['state', 'update', 'Status', 'Ready to execute'], missingDir);
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.updated, false, 'missing STATE.md should return updated:false');
    } finally {
      cleanup(missingDir);
    }
  });
});
