'use strict';

// Policy regression test for issue #138:
// Nyquist activation must be absent-safe. ADR-857 phase 6 moved that defaulting
// into `loop render-hooks verify:post`, so workflows must consume the capability
// hook instead of calling config-get directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');
}

function assertNyquistCapabilityGate(name) {
  const content = readWorkflow(name);
  assert.ok(
    content.includes('loop render-hooks verify:post'),
    `${name} must resolve Nyquist activation through verify:post capability hooks`
  );
  assert.ok(
    content.includes('ref.skill == "validate-phase"'),
    `${name} must identify the validate-phase capability hook`
  );
  assert.ok(
    !content.includes('config-get workflow.nyquist_validation'),
    `${name} must not read workflow.nyquist_validation directly after capability cutover`
  );
}

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

test('validate-phase.md: Nyquist activation uses verify:post capability hook', () => {
  assertNyquistCapabilityGate('validate-phase.md');
});

test('audit-milestone.md: Nyquist activation uses verify:post capability hook', () => {
  assertNyquistCapabilityGate('audit-milestone.md');
});

test('legacy Nyquist config helper still detects unsafe direct reads', () => {
  const tmp = path.join(os.tmpdir(), `policy-138-synthetic-${process.pid}.md`);
  try {
    fs.writeFileSync(tmp, 'NYQUIST_CFG=$(gsd_run query config-get workflow.nyquist_validation --raw)\n');
    const result = findNyquistConfigLine(tmp);
    assert.ok(result, 'synthetic direct config read should be detected');
    assert.ok(!result.line.includes('--default'), 'synthetic unsafe read intentionally lacks --default');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup for synthetic file.
    }
  }
});
