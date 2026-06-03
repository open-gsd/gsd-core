'use strict';

/**
 * Regression test for #2911.
 *
 * Two bugs in the `audit-open` dispatch case in bin/gsd-tools.cjs:
 *
 *   1. Bare `output(...)` calls (only `core.output` is in scope) → ReferenceError.
 *   2. Even after switching to `core.output(formatted, raw)`, the human-readable
 *      branch JSON-stringifies the formatted string because `core.output` only
 *      bypasses JSON encoding when called as `core.output(null, true, rawValue)`.
 *      Result: stdout contains `"━━━…\n  Milestone Close: …\n…"` (a JSON string
 *      literal) instead of the rendered report.
 *
 * The shape assertions below catch both regressions structurally — never via
 * substring matching on serialized output:
 *
 *   - text mode: parse stdout as a sequence of lines and assert the expected
 *     section headers exist as standalone lines (i.e. raw text, not escaped).
 *     If the report is JSON-stringified, the stdout is a single line wrapped
 *     in double quotes with `\n` escapes — line-array assertions fail.
 *   - --json mode: JSON.parse the stdout and assert the keys returned by
 *     `auditOpenArtifacts(cwd)` (scanned_at, has_open_items, counts, items)
 *     are present and well-typed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('audit-open — output shape (#2911)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-bug-2911-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('text mode emits the formatted report as raw text (not JSON-encoded)', () => {
    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(
      result.success,
      `audit-open must not crash. stderr: ${result.error}`
    );

    const lines = result.output.split('\n').map(l => l.trim()).filter(Boolean);

    // The first non-empty line must be the divider character row, *not* a
    // JSON-encoded string starting with a quote. If core.output JSON-stringified
    // the formatted report, the entire payload sits on one line wrapped in
    // double quotes ("━━━…\n…").
    assert.ok(
      !result.output.startsWith('"'),
      'text-mode stdout must not begin with a JSON quote (would mean the report was JSON.stringified)'
    );
    assert.ok(
      !result.output.includes('\\n'),
      'text-mode stdout must not contain literal "\\n" sequences (would mean the report was JSON.stringified)'
    );

    // Section headers from formatAuditReport that must appear as standalone lines.
    assert.ok(
      lines.includes('Milestone Close: Open Artifact Audit'),
      `expected report title as a standalone line; got lines: ${JSON.stringify(lines.slice(0, 5))}`
    );
    assert.ok(
      lines.includes('All artifact types clear. Safe to proceed.'),
      `expected the empty-state line as standalone text; got lines: ${JSON.stringify(lines)}`
    );
  });

  test('--json mode emits parseable JSON matching auditOpenArtifacts shape', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(
      result.success,
      `audit-open --json must not crash. stderr: ${result.error}`
    );

    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'audit-open --json must emit valid JSON (not a doubly-stringified string)'
    );

    assert.equal(typeof parsed, 'object', 'parsed payload must be an object');
    assert.ok(parsed !== null, 'parsed payload must not be null');

    // Shape contract from auditOpenArtifacts() in gsd-core/bin/lib/audit.cjs.
    assert.equal(typeof parsed.scanned_at, 'string', 'must include scanned_at ISO timestamp');
    assert.equal(typeof parsed.has_open_items, 'boolean', 'must include has_open_items boolean');
    assert.equal(typeof parsed.counts, 'object', 'must include counts object');
    assert.equal(typeof parsed.items, 'object', 'must include items object');

    const expectedCountKeys = [
      'debug_sessions', 'quick_tasks', 'threads', 'todos',
      'seeds', 'uat_gaps', 'verification_gaps', 'context_questions', 'total',
    ];
    for (const key of expectedCountKeys) {
      assert.equal(
        typeof parsed.counts[key], 'number',
        `counts.${key} must be a number`
      );
    }

    const expectedItemKeys = [
      'debug_sessions', 'quick_tasks', 'threads', 'todos',
      'seeds', 'uat_gaps', 'verification_gaps', 'context_questions',
    ];
    for (const key of expectedItemKeys) {
      assert.ok(
        Array.isArray(parsed.items[key]),
        `items.${key} must be an array`
      );
    }
  });
});
