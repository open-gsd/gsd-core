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
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

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
  // opened and admin-merged unconditionally — the whole point of the workflow.
  test('the ancestry-establishing steps (open PR + admin-merge) are present', () => {
    assert.ok(findStep(steps, 'Open or update PR').step, "expected an 'Open or update PR' step");
    assert.ok(findStep(steps, 'Admin-merge the back-merge PR').step, "expected an 'Admin-merge the back-merge PR' step");
  });

  // Closes the subtler regression the `continue-on-error` alone can't stop: a
  // future edit could re-gate the ancestry steps on the version-sync outcome
  // (e.g. `if: ... && steps.sync.outcome == 'success'`), silently reinstating
  // the exact coupling this fix removes. The ancestry steps must never gate on
  // any step's outcome/conclusion — only on next_exists (+ needs_review).
  test('the ancestry steps are NOT gated on any step outcome/conclusion', () => {
    for (const name of ['Open or update PR', 'Admin-merge the back-merge PR']) {
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
});
