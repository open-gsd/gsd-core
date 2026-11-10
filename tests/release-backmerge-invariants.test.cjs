'use strict';

// allow-test-rule: source-text-is-the-product #2504
// These assertions read the release-critical workflow YAML because the YAML
// *is* the contract. They lock in the durable fix for the recurring
// auto-backmerge breakage (#2504): the workflow file lives in divergent
// main/next copies that the release merges overwrite, so a fix applied to one
// copy silently regresses in the other. This test runs on every branch, so a
// PR that ships a copy missing these invariants fails HERE — at PR time —
// instead of at release time when `main` has already diverged from `next`.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const HAS_ADMIN_TOKEN_EXPR = "${{ secrets.GSD_BOT_PR_TOKEN != '' }}";

// The step's `run` text up to (not including) the first line matching `stopRe`.
function runPrefix(run, stopRe) {
  const lines = run.split('\n');
  const idx = lines.findIndex((l) => stopRe.test(l));
  assert.notEqual(idx, -1, `no line matching ${stopRe} in the step's run`);
  return lines.slice(0, idx).join('\n') + '\n';
}

function runGuard(guard, token, extraEnv) {
  return spawnSync('bash', ['-c', guard], {
    env: { ...process.env, HAS_ADMIN_TOKEN: token, ...extraEnv },
    encoding: 'utf8',
    timeout: QUICK_SPAWN_TIMEOUT_MS,
  });
}

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
}

// Locate a step by a substring of its `name`, returning { step, index }.
function findStep(steps, nameSubstring) {
  const index = steps.findIndex((s) => typeof s.name === 'string' && s.name.includes(nameSubstring));
  return { step: index === -1 ? null : steps[index], index };
}

describe('release backmerge invariants (#2504) — auto-backmerge.yml', () => {
  const wf = loadWorkflow('auto-backmerge.yml');
  const steps = wf.jobs && wf.jobs.backmerge && wf.jobs.backmerge.steps;

  test('the backmerge job exists with a steps array', () => {
    assert.ok(Array.isArray(steps), 'jobs.backmerge.steps must be an array');
  });

  // Part 1 — blast-radius containment. The version-sync must NOT be able to
  // abort the job; if it could, a regressed/again-broken copy (or any npm
  // `version` lifecycle hiccup) skips "Open PR" and leaves `main` diverged.
  test("the 'Sync next's version' step is continue-on-error (cannot abort the ancestry PR)", () => {
    const { step } = findStep(steps, "Sync next's version");
    assert.ok(step, "expected a step named like \"Sync next's version\"");
    assert.equal(
      step['continue-on-error'],
      true,
      "version-sync must be continue-on-error so a sync failure never blocks the back-merge PR " +
        '(the load-bearing step that makes `main` an ancestor of `next`). See #2504.'
    );
  });

  test('the build:lib prerequisite step exists, is continue-on-error, and runs BEFORE the version-sync', () => {
    const buildIndex = steps.findIndex(
      (s) => typeof s.run === 'string' && /npm run build:lib/.test(s.run)
    );
    assert.notEqual(buildIndex, -1, 'expected a step running `npm run build:lib` before the version sync');
    assert.equal(
      steps[buildIndex]['continue-on-error'],
      true,
      'the build:lib step is only a prerequisite of the best-effort version-sync; it must be ' +
        'continue-on-error too so its failure cannot abort the ancestry PR. See #2504.'
    );
    const { index: syncIndex } = findStep(steps, "Sync next's version");
    assert.ok(
      buildIndex < syncIndex,
      'the build:lib step must precede the version-sync step so the `version` lifecycle hook ' +
        '(gen-capability-registry.cjs) finds the built capability-ledger.cjs. This exact ordering ' +
        'regressed once already (329233fc8 added it; a release merge-back overwrote the copy). See #2504.'
    );
  });

  // The ancestry-establishing steps must be present. Together with the two
  // continue-on-error assertions above, this guarantees the back-merge PR is
  // opened and merged as a merge commit unconditionally — the whole point of the workflow.
  test('the ancestry-establishing steps (open PR + merge-commit merge) are present', () => {
    assert.ok(findStep(steps, 'Open or update PR').step, "expected an 'Open or update PR' step");
    assert.ok(findStep(steps, 'Merge the back-merge PR as a merge commit').step, "expected an 'Merge the back-merge PR as a merge commit' step");
  });

  // Closes the subtler regression the `continue-on-error` alone can't stop: a
  // future edit could re-gate the ancestry steps on the version-sync outcome
  // (e.g. `if: ... && steps.sync.outcome == 'success'`), silently reinstating
  // the exact coupling this fix removes. The ancestry steps must never gate on
  // any step's outcome/conclusion — only on next_exists (+ needs_review).
  test('the ancestry steps are NOT gated on any step outcome/conclusion', () => {
    for (const name of ['Open or update PR', 'Merge the back-merge PR as a merge commit']) {
      const { step } = findStep(steps, name);
      assert.ok(step, `expected a '${name}' step`);
      const cond = typeof step.if === 'string' ? step.if : '';
      assert.doesNotMatch(
        cond,
        /\.(outcome|conclusion)\b/,
        `'${name}' must not gate on a step outcome/conclusion — that would let a version-sync ` +
          `failure block the ancestry PR again, re-opening the divergence loop. See #2504. (if: ${cond})`
      );
    }
  });

  test('the back-merge lands through merge-commit-pr.cjs, never `gh pr merge` (#5894)', () => {
    const { step } = findStep(steps, 'Merge the back-merge PR as a merge commit');
    assert.ok(step);
    assert.match(step.run || '', /node scripts\/merge-commit-pr\.cjs "\$PR"/);
    assert.doesNotMatch(step.run || '', /gh pr merge/);
  });

  test('the back-merge step reads HAS_ADMIN_TOKEN from the secret and its guard fails without the token (#5894)', () => {
    const { step } = findStep(steps, 'Merge the back-merge PR as a merge commit');
    assert.ok(step);
    assert.equal(step.env.HAS_ADMIN_TOKEN, HAS_ADMIN_TOKEN_EXPR);
  });

  test('the back-merge guard exits 1 with ::error:: without the token and 0 with it (#5894)', { skip: process.platform === 'win32' }, () => {
    const { step } = findStep(steps, 'Merge the back-merge PR as a merge commit');
    assert.ok(step);
    // Stop at the line that RUNS the script, not the echo that mentions it.
    const guard = runPrefix(step.run, /^\s*node scripts\/merge-commit-pr\.cjs\b/);
    const without = runGuard(guard, 'false', { PR: '77' });
    assert.equal(without.status, 1);
    assert.ok(without.stdout.includes('::error::'));
    const withToken = runGuard(guard, 'true', { PR: '77' });
    assert.equal(withToken.status, 0);
  });

  test('the -s ours reconcile step is present (never-conflict back-merge)', () => {
    const reconcile = steps.find((s) => typeof s.run === 'string' && /merge\s+-s\s+ours/.test(s.run));
    assert.ok(reconcile, 'expected a `git merge -s ours` reconcile step keeping next\'s tree wholesale');
  });
});

describe('release backmerge invariants (#2504) — release.yml finalize', () => {
  const wf = loadWorkflow('release.yml');

  // Sibling of the same regression family (#2281): the finalize job's
  // `npm ci` + coverage run exceeds a 10m budget, so a too-small timeout
  // cancels it mid-test before tag/publish. The rc job uses 30; finalize must
  // match. Prone to the same copy-shuffle regression, so pin it here.
  test('the finalize job timeout is at least the rc budget (>= 30 minutes)', () => {
    const finalize = wf.jobs && wf.jobs.finalize;
    assert.ok(finalize, 'expected a finalize job in release.yml');
    assert.ok(
      typeof finalize['timeout-minutes'] === 'number' && finalize['timeout-minutes'] >= 30,
      `finalize timeout-minutes must be >= 30 (was ${finalize['timeout-minutes']}); a smaller budget ` +
        'cancels finalize mid-test before tag/publish as the unit suite grows. See #2280/#2281.'
    );
  });

  // #2515: the release/hotfix → main merge-back must complete automatically when
  // clean, not sit as a manual merge every release. This locks in that step and
  // its guardrails: it merges only a MERGEABLE PR (never force-merges a
  // conflict), and is non-fatal (a published release stands even if the
  // merge-back can't auto-complete).
  const finalizeSteps = (wf.jobs && wf.jobs.finalize && wf.jobs.finalize.steps) || [];
  const automerge = finalizeSteps.find(
    (s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')
  );

  test('finalize auto-merges the release/hotfix → main PR', () => {
    assert.ok(automerge, "expected a finalize step named like 'Auto-merge the release → main PR'");
    assert.match(
      automerge.run || '',
      /node scripts\/merge-commit-pr\.cjs "\$PR"/,
      'the auto-merge step must land the merge-back PR through merge-commit-pr.cjs (a verified merge commit, #5894). See #2515.'
    );
    assert.doesNotMatch(automerge.run || '', /gh pr merge/);
  });

  test('validate-version requires main to be an ancestor of next, after the published-version check (#5894)', () => {
    const vSteps = (wf.jobs && wf.jobs['validate-version'] && wf.jobs['validate-version'].steps) || [];
    const { step, index } = findStep(vSteps, 'Require main to be an ancestor of next');
    const { index: publishedIdx } = findStep(vSteps, 'Reject already-published versions');
    assert.ok(step, "expected a 'Require main to be an ancestor of next' step");
    assert.ok(publishedIdx !== -1, "expected a 'Reject already-published versions' step");
    assert.ok(index > publishedIdx);
    assert.ok((step.run || '').includes('node scripts/release-ancestry.cjs --ancestor origin/main --descendant origin/next'));
  });

  test('every other job needs validate-version, so the ancestry gate runs before any tagging job (#5894)', () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === 'validate-version') continue;
      const needs = [].concat(job.needs || []);
      assert.ok(needs.includes('validate-version'), `job ${name} must list validate-version in needs`);
    }
  });

  test('validate-version gates the ancestry step on non-rc, non-hotfix runs (#5894)', () => {
    const vSteps = (wf.jobs && wf.jobs['validate-version'] && wf.jobs['validate-version'].steps) || [];
    const { step } = findStep(vSteps, 'Require main to be an ancestor of next');
    assert.ok(step);
    assert.equal(step.if, "inputs.action != 'rc' && steps.validate.outputs.is_hotfix != 'true'");
  });

  test('the auto-merge step reads HAS_ADMIN_TOKEN from the secret (#5894)', () => {
    assert.ok(automerge);
    assert.equal(automerge.env.HAS_ADMIN_TOKEN, HAS_ADMIN_TOKEN_EXPR);
  });

  test('the auto-merge guard warns and exits 0 without the token, and stays silent with it (#5894)', { skip: process.platform === 'win32' }, () => {
    assert.ok(automerge);
    const guard = runPrefix(automerge.run, /^\s*PR=\$\(gh pr list/);
    const without = runGuard(guard, 'false', {});
    assert.equal(without.status, 0);
    assert.ok(without.stdout.includes('::warning::'));
    const withToken = runGuard(guard, 'true', {});
    assert.equal(withToken.status, 0);
    assert.ok(!withToken.stdout.includes('GSD_BOT_PR_TOKEN is not set'));
  });

  test('the auto-merge only fires on a cleanly MERGEABLE PR (never force-merges a conflict)', () => {
    assert.ok(automerge, "expected the 'Auto-merge the release → main PR' step");
    assert.match(
      automerge.run || '',
      /MERGEABLE/,
      'the auto-merge must gate on the PR being MERGEABLE so a genuine divergence is left open for ' +
        'manual resolution rather than force-merged into main. See #2515.'
    );
  });

  test('the auto-merge step is non-fatal (a published release stands even if it cannot complete)', () => {
    assert.ok(automerge, "expected the 'Auto-merge the release → main PR' step");
    assert.equal(
      automerge['continue-on-error'],
      true,
      'the merge-back auto-merge must be continue-on-error: the tag + npm publish already happened, ' +
        'so a merge-back that cannot complete (org policy, token) must not fail the release. See #2515.'
    );
  });

  test('the auto-merge runs AFTER "Verify publish" (main only absorbs a published release)', () => {
    const verifyIdx = finalizeSteps.findIndex(
      (s) => typeof s.name === 'string' && s.name.includes('Verify publish')
    );
    const automergeIdx = finalizeSteps.findIndex(
      (s) => typeof s.name === 'string' && s.name.includes('Auto-merge the release')
    );
    assert.ok(verifyIdx !== -1, "expected a 'Verify publish' step");
    assert.ok(automergeIdx !== -1, "expected the 'Auto-merge the release → main PR' step");
    assert.ok(
      automergeIdx > verifyIdx,
      'the auto-merge must run after "Verify publish" so main never absorbs a release whose npm ' +
        'publish was not confirmed. Order is the invariant, not just a comment. See #2515.'
    );
  });
});
