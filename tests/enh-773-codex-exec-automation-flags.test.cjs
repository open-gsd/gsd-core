'use strict';

// allow-test-rule: source-text-is-the-product
// Workflow markdown is runtime contract; these assertions verify that
// automated codex exec invocations carry the correct automation flags.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('enh-773: automated codex exec invocations include --ephemeral and --dangerously-bypass-hook-trust', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), 'gsd-core', 'workflows', 'review.md'),
    'utf8'
  );

  // Extract all codex exec invocation lines from code fences
  const codexExecLines = workflow
    .split('\n')
    .filter((line) => line.includes('codex exec'));

  test('review.md contains at least one codex exec invocation', () => {
    assert.ok(
      codexExecLines.length > 0,
      'review.md must contain at least one codex exec invocation'
    );
  });

  test('every codex exec invocation includes --ephemeral', () => {
    for (const line of codexExecLines) {
      assert.ok(
        line.includes('--ephemeral'),
        `codex exec invocation is missing --ephemeral:\n  ${line.trim()}`
      );
    }
  });

  test('every codex exec invocation includes --dangerously-bypass-hook-trust', () => {
    for (const line of codexExecLines) {
      assert.ok(
        line.includes('--dangerously-bypass-hook-trust'),
        `codex exec invocation is missing --dangerously-bypass-hook-trust:\n  ${line.trim()}`
      );
    }
  });

  test('--ephemeral appears before the prompt argument (flag ordering)', () => {
    for (const line of codexExecLines) {
      const ephemeralPos = line.indexOf('--ephemeral');
      const promptPos = line.indexOf(' - ');
      if (promptPos === -1) continue; // no stdin prompt arg on this line
      assert.ok(
        ephemeralPos < promptPos,
        `--ephemeral must appear before the stdin prompt argument:\n  ${line.trim()}`
      );
    }
  });

  test('--skip-git-repo-check is preserved alongside automation flags', () => {
    for (const line of codexExecLines) {
      assert.ok(
        line.includes('--skip-git-repo-check'),
        `codex exec invocation lost --skip-git-repo-check:\n  ${line.trim()}`
      );
    }
  });
});
