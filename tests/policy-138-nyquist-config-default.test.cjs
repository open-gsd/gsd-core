'use strict';

// Policy regression test for issue #138:
// config-get workflow.nyquist_validation calls in validate-phase.md and
// audit-milestone.md MUST include --default so they don't error / emit
// stderr noise when the key is absent.
//
// Form-agnostic: matches on `config-get workflow.nyquist_validation` + `--default`
// regardless of the runtime prefix ($GSD_SDK vs gsd_run), so this test
// survives PR #379's prefix rename.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

function findNyquistConfigLine(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('config-get workflow.nyquist_validation')) {
      return { lineNumber: i + 1, line: lines[i] };
    }
  }
  return null;
}

test('validate-phase.md: config-get workflow.nyquist_validation must include --default', () => {
  const filePath = path.join(WORKFLOWS_DIR, 'validate-phase.md');
  const result = findNyquistConfigLine(filePath);
  assert.ok(result, 'Should find a line containing config-get workflow.nyquist_validation in validate-phase.md');
  assert.ok(
    result.line.includes('--default'),
    `Line ${result.lineNumber} of validate-phase.md is missing --default flag.\nFound: ${result.line.trim()}`
  );
});

test('audit-milestone.md: config-get workflow.nyquist_validation must include --default', () => {
  const filePath = path.join(WORKFLOWS_DIR, 'audit-milestone.md');
  const result = findNyquistConfigLine(filePath);
  assert.ok(result, 'Should find a line containing config-get workflow.nyquist_validation in audit-milestone.md');
  assert.ok(
    result.line.includes('--default'),
    `Line ${result.lineNumber} of audit-milestone.md is missing --default flag.\nFound: ${result.line.trim()}`
  );
});
