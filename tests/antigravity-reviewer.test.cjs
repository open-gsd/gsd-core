// allow-test-rule: source-text-is-the-product (see #2073)
// gsd-core/workflows/review.md is a workflow document whose bash blocks ARE
// what /gsd-review loads and executes at runtime. Asserting the Antigravity
// invocation shape asserts the deployed contract — this is behavioral coverage
// of the workflow, not a source-grep over application code.

/**
 * Antigravity (agy) reviewer invocation tests (#2073)
 *
 * The agy block in /gsd-review had three real-world failure modes on agy 1.0.16:
 *   1. inline `-p "$(cat <prompt>)"` overflowed the exec arg list on a large prompt
 *   2. a pinned model that 404'd exited 0 with empty stdout AND an empty transcript
 *      (no --model escape hatch; the generic Step 3 stub gave no diagnostic)
 *   3. a pre-session stall hung past --print-timeout (which can't fire before a
 *      session exists) because there was no external wall-clock `timeout`
 * Plus a stale maintainer note claiming agy has no --model flag.
 *
 * These tests pin the corrected invocation shape in gsd-core/workflows/review.md.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REVIEW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'review.md');

function agyBashBlock() {
  const content = fs.readFileSync(REVIEW_PATH, 'utf-8');
  const fences = content.match(/```bash[\s\S]*?```/g) || [];
  // Target the INVOCATION block (the fence that writes the antigravity review
  // output), not the `command -v agy` detection one-liner.
  const agy = fences.find((f) => /\bagy\b/.test(f) && /gsd-review-antigravity/.test(f));
  assert.ok(agy, 'review.md should contain the agy invocation bash block');
  return agy;
}

describe('Antigravity (agy) reviewer invocation in /gsd-review (#2073)', () => {
  test('review.md exists', () => {
    assert.ok(fs.existsSync(REVIEW_PATH), 'review.md should exist');
  });

  test('#2073 mode 1 — does NOT inline the prompt via "$(cat ...)" (arg-list overflow)', () => {
    const block = agyBashBlock();
    assert.ok(
      !/"\$\(cat/.test(block),
      'agy must not inline the prompt via "$(cat …)" — a large review prompt overflows the exec arg list',
    );
  });

  test('#2073 mode 1 — uses a file-reference prompt (mirrors the Cursor block)', () => {
    const block = agyBashBlock();
    assert.ok(
      /Read the file at \/tmp\/gsd-review-prompt-/.test(block),
      'agy should reference the prompt by file path, not inline it',
    );
  });

  test('#2073 mode 3 — pairs agy with an external wall-clock killer when available (timeout/gtimeout probe)', () => {
    const block = agyBashBlock();
    // Capability probe for GNU `timeout` and macOS `gtimeout` (stock macOS has neither).
    assert.match(block, /command -v timeout/, 'agy block should probe for the `timeout` killer');
    assert.match(block, /command -v gtimeout/, 'agy block should probe for `gtimeout` (macOS Homebrew)');
    // The external cap (600s) is >= agy's native --print-timeout (540s) so it only
    // backstops a pre-session stall, never cuts a healthy run.
    assert.match(block, /600 agy --print-timeout 540s/, 'external cap (600s) must be >= --print-timeout (540s)');
    // Graceful fallback when no external killer is available (stock macOS).
    assert.match(block, /else\n\s*agy --print-timeout 540s/,
      'agy block must fall back to --print-timeout alone when no external killer is available (macOS)');
  });

  test('#2073 mode 3 — stdin is tied to /dev/null (no tty stall)', () => {
    const block = agyBashBlock();
    assert.ok(
      /<\/dev\/null/.test(block),
      'agy invocation should redirect stdin from /dev/null so it never blocks on a tty',
    );
  });

  test('#2073 mode 2 — wires review.models.agy via --model when configured', () => {
    const block = agyBashBlock();
    assert.match(block, /--model "\$AGY_MODEL"/, 'agy block should pass --model "$AGY_MODEL" when set');
  });

  test('#2073 mode 2 — Step 3 stub surfaces a diagnostic from agy cli.log (not just a generic stub)', () => {
    const block = agyBashBlock();
    assert.ok(
      /cli\.log/.test(block),
      'the empty-output stub should inspect agy cli.log for a model-availability diagnostic (NOT_FOUND / agent executor error)',
    );
  });

  test('#2073 — stale "no --model flag" maintainer note is corrected', () => {
    const content = fs.readFileSync(REVIEW_PATH, 'utf-8');
    assert.ok(
      !/No .{0,4}-m.{0,4}\/.{0,4}--model.{0,4} flag/i.test(content),
      'the stale maintainer note claiming agy has no --model flag must be corrected (--model exists since ~1.0.3)',
    );
  });

  test('#2073 — review.models.agy is documented as supported (not "reserved for future")', () => {
    const content = fs.readFileSync(REVIEW_PATH, 'utf-8');
    assert.ok(
      !/review\.models\.agy is reserved for future/i.test(content),
      'review.models.agy is now wired (passed as --model); the "reserved for future" comment must be updated',
    );
  });
});
