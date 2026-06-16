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

  // Extract codex exec INVOCATION lines from code fences. The #1115 capability
  // probe (`codex exec --help | grep …`) is not an automation invocation, so it
  // is excluded from the per-invocation flag assertions below.
  const codexExecLines = workflow
    .split('\n')
    .filter((line) => line.includes('codex exec') && !line.includes('codex exec --help'));

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

  test('#1115: the hook-trust bypass is capability-gated, not passed unconditionally', () => {
    // --dangerously-bypass-hook-trust only exists on codex-cli >= 0.137.0. It must
    // be probed (`codex exec --help | grep`) and applied via $CODEX_BYPASS_FLAG so
    // older installs do not fail with "unexpected argument" (a silent empty review).
    assert.ok(
      /codex exec --help[^\n]*grep[^\n]*--dangerously-bypass-hook-trust/.test(workflow),
      'review.md must capability-probe --dangerously-bypass-hook-trust via `codex exec --help | grep`'
    );
    assert.ok(
      workflow.includes('CODEX_BYPASS_FLAG="--dangerously-bypass-hook-trust"'),
      'the probe must set CODEX_BYPASS_FLAG to the flag when the CLI supports it'
    );
    for (const line of codexExecLines) {
      assert.ok(
        line.includes('$CODEX_BYPASS_FLAG'),
        `codex exec invocation must apply the capability-gated $CODEX_BYPASS_FLAG, not an unconditional flag:\n  ${line.trim()}`
      );
      // …and must NOT also pass the literal flag (that would reintroduce #1115).
      assert.ok(
        !line.includes('--dangerously-bypass-hook-trust'),
        `codex exec invocation must not pass the literal --dangerously-bypass-hook-trust (use the gated $CODEX_BYPASS_FLAG):\n  ${line.trim()}`
      );
    }
  });

  test('#1115: codex review failures are surfaced, not silently swallowed', () => {
    // stderr must be captured (not discarded to /dev/null) and an empty output
    // must be replaced with a diagnostic, so a broken reviewer is reported.
    for (const line of codexExecLines) {
      assert.ok(
        !line.includes('2>/dev/null'),
        `codex exec must not discard stderr to /dev/null:\n  ${line.trim()}`
      );
    }
    assert.ok(
      /\[ ! -s \/tmp\/gsd-review-codex-\{phase\}\.md \]/.test(workflow),
      'review.md must guard against an empty codex review output and surface the failure'
    );
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
