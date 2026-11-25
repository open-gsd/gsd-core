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
  const match = blocks.find((block) => block.includes('git push'));
  assert.ok(match, 'track_shipping must contain an executable bash block that pushes the ship-note');
  return match;
}

// Runs the step's bash block with gsd_run / git / gh stubbed; records every call.
function runTrackShipping() {
  const tmpDir = createTempDir('gsd-ship-note-');
  const callsPath = path.join(tmpDir, 'calls.log');
  try {
    fs.writeFileSync(callsPath, '', 'utf8');
    const preamble = [
      // `query planning.inspect --pick generated_from.planning_root` returns the fixture's absolute
      // `.planning` dir (#5861); every call is recorded.
      'gsd_run() { printf "gsd_run %s\\n" "$*" >> "$CALLS"; if [ "$2" = "planning.inspect" ]; then printf "%s" "$PWD/.planning"; fi; }',
      'git() { printf "git %s\\n" "$*" >> "$CALLS"; }',
      'gh() { printf "gh %s\\n" "$*" >> "$CALLS"; }',
    ].join('\n');
    const result = spawnSync('bash', ['-c', `${preamble}\n${extractTrackShippingScript()}`], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: QUICK_SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        CALLS: callsPath,
        CURRENT_BRANCH: 'fix/ship-note',
        PHASE_NUMBER: '7',
        PR_NUMBER: '123',
        padded_phase: '07',
      },
    });
    assert.strictEqual(result.status, 0, `track_shipping failed: ${result.stderr}`);
    return fs.readFileSync(callsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } finally {
    cleanup(tmpDir);
  }
}

describe('#6173 ship.md track_shipping ship-note carries no CI skip token', () => {
  test('the contract\'s token pattern is GitHub\'s documented set and matches each spelling in any case', () => {
    // GitHub's documented set, assembled so this file carries no literal token.
    assert.deepStrictEqual([...SKIP_TOKENS].sort(), ['actions skip', 'ci skip', 'no ci', 'skip actions', 'skip ci']);
    for (const token of [...SKIP_TOKENS.map((t) => `[${t}]`), `skip-checks:${'true'}`, `skip-checks: ${'true'}`]) {
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
    const calls = runTrackShipping();
    const commits = calls.filter((c) => c.startsWith('gsd_run query commit '));
    assert.strictEqual(commits.length, 1, `expected exactly one ship-note commit; calls: ${calls.join(' | ')}`);
    assert.doesNotMatch(commits[0], SKIP_TOKEN_RE);
    assert.match(commits[0], /ship phase 7 .*PR #123/);
    assert.match(commits[0], /--files \S*\/\.planning\/STATE\.md$/);
    assert.ok(calls.includes('git push origin fix/ship-note'),
      `the ship-note must still be pushed to the PR branch; calls: ${calls.join(' | ')}`);
  });

  test('issues no recovery commit and never queries the PR merge state', () => {
    const calls = runTrackShipping();
    assert.deepStrictEqual(calls.filter((c) => c.startsWith('gh ')), [], 'no gh polling');
    assert.deepStrictEqual(calls.filter((c) => c.startsWith('git commit')), [], 'no direct git commit (recovery)');
    assert.ok(!calls.some((c) => c.includes('--allow-empty')), 'no empty recovery commit');
  });
});
