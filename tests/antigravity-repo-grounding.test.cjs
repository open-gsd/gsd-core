// allow-test-rule: source-text-is-the-product (see #2073)
// gsd-core/workflows/review.md is a workflow document whose bash blocks ARE
// what /gsd-review loads and executes at runtime. Asserting the invocation
// shape asserts the deployed contract — this is behavioral coverage of the
// workflow, not a source-grep over application code.

/**
 * Antigravity reviewer repo-grounding tests (#2176)
 *
 * The agy block invoked the CLI without granting it the repo under review:
 * no --add-dir on either invocation arm, and no absolute repo-root anchor in
 * _AGY_PROMPT. The agent frequently anchored on its own
 * ~/.gemini/antigravity-cli/scratch dir, reviewed the plan text in isolation
 * (the exact failure the block's Review Instructions forbid), and its
 * ungrounded verdict flowed into the Consensus Summary at full weight,
 * undetected.
 *
 * These tests pin the fix: capability-probed --add-dir (mirrors the Codex
 * bypass-flag probe), absolute-root prompt anchor (agy AND the cursor-agent
 * block, which shared the anchor gap), a mandated self-report line, a stamped
 * blind-review marker, and consensus down-weighting of marked reviews.
 * Each assertion fails against the pre-fix block.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REVIEW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'review.md');

function reviewContent() {
  return fs.readFileSync(REVIEW_PATH, 'utf-8');
}

function agyBashBlock() {
  const fences = reviewContent().match(/```bash[\s\S]*?```/g) || [];
  const agy = fences.find((f) => /\bagy\b/.test(f) && /gsd-review-antigravity/.test(f));
  assert.ok(agy, 'review.md should contain the agy invocation bash block');
  return agy;
}

function cursorBashBlock() {
  const fences = reviewContent().match(/```bash[\s\S]*?```/g) || [];
  const cursor = fences.find((f) => /cursor-agent -p/.test(f));
  assert.ok(cursor, 'review.md should contain the cursor-agent invocation bash block');
  return cursor;
}

describe('Antigravity reviewer repo grounding in /gsd-review (#2176)', () => {
  test('probes agy for --add-dir support (capability-probe idiom, mirrors the Codex block)', () => {
    const block = agyBashBlock();
    assert.ok(
      /agy --help 2>\/dev\/null \| grep -q -- '--add-dir'/.test(block),
      'agy block must capability-probe --add-dir via `agy --help | grep -q` so older CLIs still run',
    );
  });

  test('passes --add-dir with the repo root when supported', () => {
    const block = agyBashBlock();
    assert.ok(
      /set -- "\$@" --add-dir "\$_AGY_WS"/.test(block),
      'the probed arm must append --add-dir "$_AGY_WS" so both invocation arms (which expand "$@") receive it',
    );
  });

  test('_AGY_PROMPT is anchored to the absolute repo root', () => {
    const block = agyBashBlock();
    const promptLine = block.split('\n').find((l) => l.startsWith('_AGY_PROMPT='));
    assert.ok(promptLine, 'agy block must define _AGY_PROMPT');
    assert.ok(
      /\$_AGY_WS/.test(promptLine),
      '_AGY_PROMPT must embed the absolute repo root ($_AGY_WS) so repo-relative references resolve on the no---add-dir fallback',
    );
  });

  test('_AGY_PROMPT mandates a REVIEWED-WITHOUT-REPO-ACCESS self-report', () => {
    const block = agyBashBlock();
    const promptLine = block.split('\n').find((l) => l.startsWith('_AGY_PROMPT='));
    assert.ok(
      /REVIEWED-WITHOUT-REPO-ACCESS/.test(promptLine),
      '_AGY_PROMPT must require the exact self-report line when the reviewer cannot read the repo',
    );
  });

  test('stamps a blind-review marker on self-reported or scratch-anchored output', () => {
    const block = agyBashBlock();
    assert.ok(
      /head -5 [^|]*\| grep -q 'REVIEWED-WITHOUT-REPO-ACCESS'/.test(block),
      'the self-report tell must be anchored to the head of the output, not a whole-body substring',
    );
    assert.ok(
      /grep -qiE '\(workspace\|working\) \(directory\|dir\)\.\{0,40\}antigravity-cli\/scratch'/.test(block),
      'the scratch tell must be anchored to a workspace-declaration phrasing whose bridge (.{0,40}) can span the dotted ~/.gemini/ path prefix',
    );
    assert.ok(
      /\[reviewed-without-repo-access\]/.test(block),
      'detected blind reviews must be stamped with the [reviewed-without-repo-access] marker',
    );
  });

  test('marker stamping avoids sed -i (BSD/GNU divergence) — uses temp file + mv', () => {
    const block = agyBashBlock();
    assert.ok(!/sed -i/.test(block), 'agy block must not use sed -i (BSD vs GNU incompatibility)');
    assert.ok(
      /\.tmp && \\?\s*\n?\s*mv /.test(block),
      'marker stamping should rewrite via temp file + mv',
    );
  });

  test('Consensus Summary down-weights marked blind reviews', () => {
    const content = reviewContent();
    const consensusIdx = content.indexOf('## Consensus Summary');
    assert.ok(consensusIdx >= 0, 'review.md should contain the Consensus Summary section');
    const consensus = content.slice(consensusIdx, consensusIdx + 2000);
    assert.ok(
      /\[reviewed-without-repo-access\]/.test(consensus),
      'consensus instructions must reference the blind-review marker',
    );
    assert.ok(
      /REVIEWED-WITHOUT-REPO-ACCESS/.test(consensus),
      'consensus instructions must also honor the raw self-report line',
    );
    assert.ok(
      /not count its verdict at full consensus weight/.test(consensus),
      'marked reviews must be down-weighted, not counted at full weight',
    );
  });

  test('blind-review detection behaves correctly on synthetic transcripts', () => {
    // Behavioral, not string-on-string: extract the actual detection compound
    // from the fence, point it at a temp file, and run it through bash for
    // ungrounded and grounded transcript shapes.
    const os = require('os');
    const { execFileSync } = require('node:child_process');
    const { toPosixPath } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    const block = agyBashBlock();
    const m = block.match(/\{ head -5[\s\S]*?\}; then/);
    assert.ok(m, 'detection compound not found in the agy block');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-detect-'));
    const out = path.join(tmp, 'review-out.md');
    const detect = m[0]
      .replace(/\}; then$/, '}')
      // Convert the native path to POSIX form so it survives bash on Windows
      // runners (Git Bash accepts D:/... but eats backslashes).
      .replaceAll('/tmp/gsd-review-antigravity-{phase}.md', toPosixPath(out));
    const runDetect = (content) => {
      fs.writeFileSync(out, content);
      try {
        execFileSync('bash', ['-c', detect], { stdio: 'ignore' });
        return true; // exit 0 → blind review detected
      } catch {
        return false;
      }
    };
    try {
      // Ungrounded tells — must be stamped
      assert.equal(runDetect('REVIEWED-WITHOUT-REPO-ACCESS\n\n## Review\nPlan-only review.\n'), true,
        'self-report line in the head must be detected');
      assert.equal(runDetect('## Review\nMy working directory is ~/.gemini/antigravity-cli/scratch.\nPlan-only review.\n'), true,
        'full dotted scratch path in a workspace declaration must be detected (#2184 re-review Major)');
      assert.equal(runDetect('Workspace directory: /home/me/.gemini/antigravity-cli/scratch\n'), true,
        'colon-style workspace declaration must be detected');
      // Grounded shapes — must NOT be stamped
      assert.equal(runDetect('## Review\nVerified hooks/gsd-statusline.js against the plan. Solid.\n'), false,
        'ordinary grounded review must not be stamped');
      assert.equal(runDetect('## Review\nThe workflow mentions antigravity-cli/scratch as the agy scratch dir; the guard there is correct.\n'), false,
        'grounded review merely quoting the scratch path must not be stamped');
      assert.equal(
        runDetect('## Review\n\nGrounded findings below.\n\n### Details\nLine 20 of the workflow mentions REVIEWED-WITHOUT-REPO-ACCESS as the self-report marker; fine.\n'),
        false,
        'self-report string quoted beyond the first 5 lines must not be stamped');
    } finally {
      require('./helpers.cjs').cleanup(tmp);
    }
  });

  test('cursor-agent prompt carries the same absolute-root anchor (identical gap, #2176 AC5)', () => {
    const block = cursorBashBlock();
    assert.ok(
      /_CURSOR_ROOT="\$\(git rev-parse --show-toplevel 2>\/dev\/null \|\| pwd\)"/.test(block),
      'cursor anchor must resolve the repo TOP-LEVEL (rev-parse, not bare pwd) so subdirectory invocations anchor correctly',
    );
    const promptLine = block.split('\n').find((l) => l.startsWith('CURSOR_PROMPT_ARG='));
    assert.ok(promptLine, 'cursor block must define CURSOR_PROMPT_ARG');
    assert.ok(
      /repository under review is at \$_CURSOR_ROOT/.test(promptLine),
      'CURSOR_PROMPT_ARG must anchor repo-relative references to the absolute repo root',
    );
  });
});
