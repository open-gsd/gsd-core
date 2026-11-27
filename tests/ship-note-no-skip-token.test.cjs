'use strict';

/**
 * #6173 — the ship-note commit written by ship.md's track_shipping step must
 * not carry a CI skip token.
 *
 * GitHub honors the skip tokens anywhere in a commit message, and a squash
 * (default message) or rebase merge copies the PR branch's commit messages onto
 * the default branch, where the token suppresses the merge push's workflow runs.
 * Without the token there is no wedge to recover from, so the empty recovery
 * commit and the mergeStateStatus polling (#2783) that existed only for it are
 * gone too. One docs-only pipeline on the PR branch is accepted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { stripFencedCode, scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { cleanup, createTempDir, readFileNormalized } = require('./helpers.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');

// One token pattern, owned by the ship-note text contract (which checks the step text); this file runs the step.
const { SKIP_TOKENS, SKIP_TOKEN_RE } = require('../scripts/static-checks/text-contracts/ship-note.cjs');

function extractStep(name) {
  const content = readFileNormalized(SHIP_MD);
  const open = `<step name="${name}">`;
  const start = content.indexOf(open);
  assert.notEqual(start, -1, `ship.md must contain a ${name} step`);
  const end = content.indexOf('</step>', start);
  assert.notEqual(end, -1, `${name} step must close`);
  return content.slice(start, end);
}

function extractTrackShippingScript() {
  const step = extractStep('track_shipping');
  const lines = step.split(/\r?\n/);
  const blocks = scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash')
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  assert.ok(blocks.some((block) => block.includes('git push')), 'track_shipping must contain an executable bash block that pushes the ship-note');
  // Every bash block of the step, in order: the activity-line update, then the commit and push.
  return blocks.join('\n');
}

// Runs the step's bash block with gsd_run / git / gh stubbed; records every call.
function runTrackShipping({ failPush = false } = {}) {
  const tmpDir = createTempDir('gsd-ship-note-');
  const callsPath = path.join(tmpDir, 'calls.log');
  try {
    fs.writeFileSync(callsPath, '', 'utf8');
    const preamble = [
      // `query planning.inspect --pick generated_from.planning_root` returns the fixture's absolute
      // `.planning` dir (#5861); every call is recorded.
      'gsd_run() { printf "gsd_run %s\\n" "$*" >> "$CALLS"; if [ "$2" = "planning.inspect" ]; then printf "%s" "$PWD/.planning"; fi; }',
      'git() { printf "git %s\\n" "$*" >> "$CALLS"; if [ "$1" = push ] && [ -n "$FAIL_PUSH" ]; then return 1; fi; }',
      'gh() { printf "gh %s\\n" "$*" >> "$CALLS"; }',
    ].join('\n');
    const result = spawnSync('bash', ['-c', `${preamble}\n${extractTrackShippingScript()}`], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: QUICK_SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        CALLS: callsPath,
        FAIL_PUSH: failPush ? '1' : '',
        CURRENT_BRANCH: 'fix/ship-note',
        PHASE_NUMBER: '7',
        PR_NUMBER: '123',
        padded_phase: '07',
      },
    });
    assert.strictEqual(result.status, 0, `track_shipping failed: ${result.stderr}`);
    return { calls: fs.readFileSync(callsPath, 'utf8').split(/\r?\n/).filter(Boolean), stdout: result.stdout };
  } finally {
    cleanup(tmpDir);
  }
}

describe('#6173 ship.md track_shipping ship-note carries no CI skip token', () => {
  test('the contract\'s token pattern is GitHub\'s documented set and matches each spelling in any case', () => {
    // GitHub's documented set, assembled so this file carries no literal token.
    assert.deepStrictEqual([...SKIP_TOKENS].sort(), ['actions skip', 'ci skip', 'no ci', 'skip actions', 'skip ci']);
    // The trailer is matched bare: two spaces, a tab or any other value after the colon still counts.
    const trailers = [`skip-checks:${'true'}`, `skip-checks: ${'true'}`, `skip-checks:  ${'true'}`, `skip-checks:\t${'true'}`, `skip-checks: ${'false'}`];
    for (const token of [...SKIP_TOKENS.map((t) => `[${t}]`), ...trailers]) {
      assert.match(`docs: ship-note ${token}`, SKIP_TOKEN_RE);
      assert.match(`docs: ship-note ${token.toUpperCase()}`, SKIP_TOKEN_RE);
    }
    assert.doesNotMatch('docs(07): ship phase 7 — PR #123', SKIP_TOKEN_RE);
  });

  test('track_shipping and the following step remain outside balanced code fences', () => {
    const content = fs.readFileSync(SHIP_MD, 'utf8');
    const stripped = stripFencedCode(content);
    assert.strictEqual(stripped.unterminatedFence, false, 'ship.md must not contain an unterminated code fence');
    assert.match(
      stripped.text,
      /<step name="track_shipping">[\s\S]*?<\/step>\s*<step name="ship_post_capability_dispatch">/,
      'the track_shipping boundary and following step must remain visible after stripping code fences',
    );
  });
});

describe('#6173 executing track_shipping', { skip: process.platform === 'win32' }, () => {
  test('commits the ship-note without a skip token, with phase and PR number, and pushes it', () => {
    const { calls } = runTrackShipping();
    const commits = calls.filter((c) => c.startsWith('gsd_run query commit '));
    assert.strictEqual(commits.length, 1, `expected exactly one ship-note commit; calls: ${calls.join(' | ')}`);
    assert.doesNotMatch(commits[0], SKIP_TOKEN_RE);
    assert.match(commits[0], /^gsd_run query commit docs\(07\): ship phase 7 .*PR #123 --files /);
    assert.match(commits[0], /--files \S*\/\.planning\/STATE\.md$/);
    const pushIdx = calls.indexOf('git push origin fix/ship-note');
    assert.notStrictEqual(pushIdx, -1, `the ship-note must still be pushed to the PR branch; calls: ${calls.join(' | ')}`);
    // #2138: the push only carries the ship-note if it follows the commit; the activity line is written before both.
    const stateIdx = calls.findIndex((c) => c.startsWith('gsd_run query state.update ') && c.includes('Last Activity'));
    const commitIdx = calls.indexOf(commits[0]);
    assert.ok(stateIdx !== -1 && stateIdx < commitIdx && commitIdx < pushIdx,
      `order must be state.update, then commit, then push; calls: ${calls.join(' | ')}`);
  });

  test('a failed push leaves the commit in place, warns and does not fail the step (control)', () => {
    const { calls, stdout } = runTrackShipping({ failPush: true });
    assert.strictEqual(calls.filter((c) => c.startsWith('gsd_run query commit ')).length, 1);
    assert.match(stdout, /track_shipping: ship-note push failed — it is local-only; rerun: git push origin fix\/ship-note/);
  });

  test('issues no recovery commit and never queries the PR merge state', () => {
    const { calls } = runTrackShipping();
    assert.deepStrictEqual(calls.filter((c) => c.startsWith('gh ')), [], 'no gh polling');
    assert.deepStrictEqual(calls.filter((c) => c.startsWith('git commit')), [], 'no direct git commit (recovery)');
    assert.ok(!calls.some((c) => c.includes('--allow-empty')), 'no empty recovery commit');
  });
});
