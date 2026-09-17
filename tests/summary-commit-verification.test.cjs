'use strict';

/**
 * #3968 — commit claims must be measured, never narrated.
 *
 * Across 14 plans / 3 phases in a real project, `commits: 1` appeared in every
 * SUMMARY while `git reflog` showed ZERO git activity in the window, and
 * HANDOFF.json asserted `uncommitted_files: []` over a dirty tree — invisible
 * because nothing downstream cross-checks the narration against git. The fix
 * (maintainer decision, option c) spans three shipped surfaces; their text IS
 * the runtime-loaded contract, so shape assertions are the faithful check.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('#3968 — measured commit claims', () => {
  test('executor measures commits, never narrates them', () => {
    const executor = read('agents/gsd-executor.md');
    // The ledger: HEAD captured at the plan's first commit, once per plan.
    assert.ok(executor.includes('gsd-plan-head-before'),
      'the ledger must persist on disk (each Bash call is a fresh shell — a variable measures zero)');
    assert.ok(executor.includes('git rev-list --count'),
      'the SUMMARY commit count must come from git rev-list --count, not narration');
    assert.ok(executor.includes('plan_head_before: ${PLAN_HEAD_BEFORE}'),
      'the base is recorded in the frontmatter so the verifier reconciles with the same instrument');
    // A measured zero WITH code changes is a HALT, never a narrated success.
    assert.ok(/HALT — do not write the\s+SUMMARY/i.test(executor),
      'a measured zero with uncommitted code changes must halt the SUMMARY write');
    // actuals.commits sources the measured count; the ADR-2629 calibration shape is kept.
    assert.ok(/commits: 7 .*MEASURED/.test(executor),
      'the actuals block sources its count from the measurement');
  });

  test('verify-work flags SUMMARY-vs-git mismatch as BLOCKER', () => {
    const verify = read('gsd-core/workflows/verify-work.md');
    assert.ok(verify.includes('Commit-claim reconciliation'),
      'verify-work must run a commit-claim reconciliation over each SUMMARY');
    assert.ok(verify.includes('ACTUAL=$(git rev-list --count "${BASE}"..HEAD)'),
      'the reconciliation uses the SAME instrument as the executor (rev-list over the recorded base)');
    assert.ok(/ACTUAL == CLAIMED \+ 1/.test(verify),
      'the post-measurement SUMMARY commit is an expected +1, not a false BLOCKER');
    assert.ok(/BLOCKER/.test(verify.slice(verify.indexOf('Commit-claim reconciliation'), verify.indexOf('Commit-claim reconciliation') + 1800)),
      'a mismatch must be flagged BLOCKER — the phase must not read as done');
  });

  test('HANDOFF uncommitted_files come from git status --porcelain', () => {
    const pause = read('gsd-core/workflows/pause-work.md');
    assert.ok(pause.includes('git status --porcelain'),
      'uncommitted_files must be populated from an actual git status --porcelain call');
    // The asserted-empty template literal is gone as the only source.
    const idx = pause.indexOf('uncommitted_files');
    assert.ok(idx === -1 || /porcelain/.test(pause.slice(Math.max(0, idx - 3000), idx + 3000)),
      'the uncommitted_files field is defined by the porcelain command, not a narrated []');
  });
});

// ── #4670 — the commit-claim window is bounded to the plan's own history ─────
// `plan_head_before..HEAD` grows with every LATER plan's commits and
// execute-phase's phase-completion commit, so an honest plan flagged as
// `commit_claim_mismatch` BLOCKER as soon as anything landed after it. The
// executor now also records `plan_head_after:` (HEAD at its measurement
// moment — after the last task commit, before the SUMMARY commit), and
// verify-work reconciles against that bounded window with EXACT equality;
// legacy SUMMARYs without the anchor fall back to the WARNING path.

describe('#4670 — bounded commit-claim reconciliation', () => {
  test('executor records plan_head_after — the plan window bound (#4670)', () => {
    const executor = read('agents/gsd-executor.md');
    assert.ok(
      executor.includes('plan_head_after: ${PLAN_HEAD_AFTER}'),
      'the SUMMARY frontmatter must carry plan_head_after, captured at the measurement moment'
    );
    assert.ok(
      /PLAN_HEAD_AFTER=\$\(git rev-parse HEAD\)/.test(executor),
      'PLAN_HEAD_AFTER must be captured from HEAD at the same measurement moment as the count'
    );
  });

  test('verify-work bounds the commit-claim window to the plan own history (#4670)', () => {
    const verify = read('gsd-core/workflows/verify-work.md');
    const afterIdx = verify.indexOf('AFTER=$(grep -oE \'^plan_head_after: [0-9a-f]{7,40}\' "$SUMMARY_FILE" | awk \'{print $2}\')');
    assert.ok(afterIdx !== -1, 'the reconciliation must extract plan_head_after');
    assert.ok(
      verify.includes('git merge-base --is-ancestor "$AFTER" HEAD'),
      'the plan end must be verified to still be in history (ancestor check)'
    );
    assert.ok(
      verify.includes('git rev-list --count "${BASE}..${AFTER}"'),
      'the measured count must be bounded to the plan own window (BASE..AFTER)'
    );
  });

  test('bounded mismatch stays a BLOCKER — #3968 failures still caught (#4670)', () => {
    const verify = read('gsd-core/workflows/verify-work.md');
    const boundedIdx = verify.indexOf('#4670');
    assert.ok(boundedIdx !== -1, 'the bounded reconciliation section must exist');
    const section = verify.slice(boundedIdx, boundedIdx + 2400);
    assert.match(section, /BLOCKER/, 'a bounded mismatch must remain a BLOCKER');
    assert.match(section, /commit_claim_mismatch/, 'the mismatch verdict name is kept');
  });

  test('legacy SUMMARYs without plan_head_after fall back to the warning path (#4670)', () => {
    const verify = read('gsd-core/workflows/verify-work.md');
    const afterNeedle = 'plan_head_after';
    assert.ok(verify.includes(afterNeedle), 'plan_head_after must appear in verify-work');
    // The legacy clause: a base without the anchor cannot be judged by the
    // unsound unbounded window — it is a WARNING with the measured state.
    assert.match(
      verify, /WARNING[\s\S]{0,400}plan_head_after/,
      'SUMMARYs without plan_head_after must fall back to the WARNING path, not the unsound BLOCKER'
    );
  });
});
