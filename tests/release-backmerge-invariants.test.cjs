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
  // Round-4 review fix (MEDIUM, code#4): split into `build` (no secrets
  // beyond GITHUB_TOKEN read; npm ci/build:lib/tree-reconcile/version-sync,
  // all committed LOCALLY) and `push` (environment: gsd-bot; downloads the
  // bundle `build` produced, pushes, opens/updates the PR, closes
  // superseded). `steps` below defaults to `build`'s steps, since most of
  // the invariants in THIS describe block (build:lib ordering,
  // continue-on-error, the shared backmerge-tree.cjs call) concern that job;
  // tests that concern `push`'s own steps (Open or update PR, superseded-PR
  // cleanup, no `gh pr merge`) explicitly use `pushSteps` instead.
  const wf = loadWorkflow('auto-backmerge.yml');
  const steps = wf.jobs && wf.jobs.build && wf.jobs.build.steps;
  const pushSteps = (wf.jobs && wf.jobs.push && wf.jobs.push.steps) || [];

  test('the build and push jobs exist, each with a steps array', () => {
    assert.ok(Array.isArray(steps), 'jobs.build.steps must be an array');
    assert.ok(Array.isArray(pushSteps) && pushSteps.length > 0, 'jobs.push.steps must be a non-empty array');
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

  // The ancestry-establishing step must be present. Together with the two
  // continue-on-error assertions above, this guarantees the back-merge PR is
  // opened unconditionally. Review fix (#4990): this job no longer
  // admin-merges at all (see the dedicated describe block below) — the
  // "Admin-merge the back-merge PR" step this test used to also require was
  // a STALE reference to a step this session's #4990 redesign already
  // removed; asserting its presence here was a latent false-negative
  // waiting to fire the next time this file's assertions actually ran.
  test('the ancestry-establishing step (open PR) is present in the push job', () => {
    assert.ok(findStep(pushSteps, 'Open or update PR').step, "expected an 'Open or update PR' step");
  });

  // Closes the subtler regression the `continue-on-error` alone can't stop: a
  // future edit could re-gate the ancestry step on the version-sync outcome
  // (e.g. `if: ... && steps.sync.outcome == 'success'`), silently reinstating
  // the exact coupling this fix removes. The ancestry step must never gate on
  // any step's outcome/conclusion — only on needs.build.outputs.* (round-4:
  // the version-sync's outcome now lives in a DIFFERENT job than "Open or
  // update PR", so there is no `steps.*.outcome` to even reference across
  // that boundary — job outputs are the only channel, and none of them carry
  // step outcome/conclusion).
  test('the ancestry step is NOT gated on any step outcome/conclusion', () => {
    for (const name of ['Open or update PR']) {
      const { step } = findStep(pushSteps, name);
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

  // #4990 review fix: the merge -s ours + CHANGELOG.md overlay + .changeset
  // replay used to be hand-written directly in this step's bash — now it is
  // ONE shared script (scripts/backmerge-tree.cjs), also called by
  // backmerge-merge-when-green.yml to verify content-binding (CLAUDE.md
  // "Generative Fix Divergence": one source, not two hand-kept copies).
  test('the reconcile step calls the shared backmerge-tree.cjs script (never re-implements -s ours locally)', () => {
    const reconcile = steps.find((s) => typeof s.run === 'string' && /backmerge-tree\.cjs\s+stage\b/.test(s.run));
    assert.ok(reconcile, 'expected a step running `node scripts/backmerge-tree.cjs stage`');
    assert.match(reconcile.run, /backmerge-tree\.cjs\s+stage[\s\S]{0,60}--main\s+origin\/main\b/);
    for (const s of steps) {
      if (typeof s.run !== 'string') continue;
      // Comment lines stripped: the step's own doc comments legitimately
      // MENTION "-s ours" prose (explaining what the shared script does),
      // which must not itself trip a check for real re-implemented bash.
      const codeOnly = s.run.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
      assert.doesNotMatch(
        codeOnly,
        /merge\s+-s\s+ours/,
        'the -s ours tree construction must live ONLY in scripts/backmerge-tree.cjs, never re-implemented '
          + `directly in a workflow step's actual commands (found in step "${s.name || '(unnamed)'}")`,
      );
    }
  });

  // #4990: auto-backmerge.yml used to admin-merge its own PR immediately
  // after opening it — #4707/#4708 landed 3-4s after creation, before a
  // single required check had even started. The fix moved the merge OUT of
  // this workflow entirely, into a separate, event-driven
  // backmerge-merge-when-green.yml (asserted further below) that only merges
  // once every required check is independently confirmed green. This job
  // must therefore contain NO `gh pr merge` at all, and its timeout must stay
  // at the original, small budget — a job that only opens/labels a PR has no
  // reason to run long.
  describe('#4990: this job no longer merges — a separate event-driven workflow does', () => {
    test('no step in either job runs `gh pr merge`', () => {
      for (const [jobId, jobSteps] of [['build', steps], ['push', pushSteps]]) {
        const mergeStep = jobSteps.find((s) => typeof s.run === 'string' && /\bgh\s+pr\s+merge\b/.test(s.run));
        assert.equal(
          mergeStep,
          undefined,
          `auto-backmerge.yml's ${jobId} job must not admin-merge its own PR — that responsibility moved to `
            + '.github/workflows/backmerge-merge-when-green.yml, which merges only once every required '
            + 'check is independently confirmed green (#4990)',
        );
      }
    });

    test('both jobs keep the original small timeout budget (5) — neither waits on anything', () => {
      const build = wf.jobs && wf.jobs.build;
      const push = wf.jobs && wf.jobs.push;
      assert.equal(build['timeout-minutes'], 5);
      assert.equal(
        push['timeout-minutes'],
        5,
        'the push job only pushes/opens/labels the PR; a larger timeout would silently re-admit a '
          + 'long-running wait/poll loop here instead of in the dedicated event-driven merger workflow',
      );
    });
  });

  // Round-4 review fix (MEDIUM, code#4): the bot token must never share a
  // job/runner with `npm ci` / build / `npm version`-adjacent hooks.
  describe('round-4 review fix (MEDIUM, code#4): build/push job split isolates the bot token from npm/build', () => {
    test('the build job has no environment and never references GSD_BOT_PR_TOKEN', () => {
      const build = wf.jobs && wf.jobs.build;
      assert.equal(build.environment, undefined, 'the build job must not declare environment: gsd-bot');
      assert.doesNotMatch(JSON.stringify(build), /GSD_BOT_PR_TOKEN/, 'the build job must never reference the bot token');
    });

    test('the push job has NO npm ci / npm run build / npm version anywhere (a bare Node runtime for the trusted script is fine — see the round-7 setup-node test below)', () => {
      for (const s of pushSteps) {
        if (typeof s.run !== 'string') continue;
        assert.doesNotMatch(s.run, /\bnpm ci\b/, `push step "${s.name}" must not run npm ci`);
        assert.doesNotMatch(s.run, /\bnpm run build\b/, `push step "${s.name}" must not run npm run build`);
        assert.doesNotMatch(s.run, /\bnpm version\b/, `push step "${s.name}" must not run npm version`);
      }
    });

    // Round-7 review fix (NIT): the trusted verify step runs `node
    // scripts/backmerge-tree.cjs` directly — push needs the Node RUNTIME
    // (setup-node), same pinned action + NODE_VERSION source as the build
    // job, but still no dependency install (no npm ci/install/run anywhere
    // in this job — asserted above).
    test('the push job runs actions/setup-node (same pinned action + NODE_VERSION source as build) before the verify step, with no npm ci', () => {
      const buildSetupNode = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
      const pushSetupNode = pushSteps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
      assert.ok(buildSetupNode, 'expected an actions/setup-node step in the build job');
      assert.ok(pushSetupNode, 'expected an actions/setup-node step in the push job');
      assert.equal(pushSetupNode.uses, buildSetupNode.uses, 'push must pin the exact same setup-node action ref as build');
      assert.equal(pushSetupNode.with && pushSetupNode.with['node-version'], '${{ env.NODE_VERSION }}');
      assert.equal(
        buildSetupNode.with && buildSetupNode.with['node-version'],
        pushSetupNode.with && pushSetupNode.with['node-version'],
        'both jobs must source node-version from the SAME workflow-level env.NODE_VERSION',
      );

      const setupNodeIdx = pushSteps.findIndex((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
      const verifyIdx = pushSteps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Verify the bundle is a genuine back-merge'));
      assert.ok(setupNodeIdx !== -1 && verifyIdx !== -1 && setupNodeIdx < verifyIdx, 'setup-node must precede the trusted verify step');
    });

    test('the push job downloads the build artifact and verifies its head sha before pushing', () => {
      const downloadStep = pushSteps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/download-artifact@'));
      assert.ok(downloadStep, 'expected a download-artifact step in the push job');
      // Round-5 review fix (SEC INFO, code#8): this check now lives in the
      // dedicated "Verify the bundle..." step, not "Push the built branch"
      // itself — see the round-5 describe block below for the full
      // ordering/content-binding assertions.
      const verifyStep = findStep(pushSteps, 'Verify the bundle is a genuine back-merge').step;
      assert.ok(verifyStep, 'expected a "Verify the bundle is a genuine back-merge..." step');
      assert.match(verifyStep.run, /git bundle verify/);
      assert.match(verifyStep.run, /ACTUAL_SHA[\s\S]{0,40}!=[\s\S]{0,20}EXPECTED_HEAD_SHA/);
    });

    test('the build job produces a git bundle and uploads it as an artifact', () => {
      const bundleStep = findStep(steps, 'Create a git bundle').step;
      assert.ok(bundleStep, 'expected a "Create a git bundle" step in the build job');
      const uploadStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'));
      assert.ok(uploadStep, 'expected an upload-artifact step in the build job');
    });
  });

  // Round-5 review fixes.
  describe('round-5 review fixes', () => {
    test('upload-artifact sets overwrite: true (so "Re-run all jobs" does not fail on the fixed name, MINOR 4)', () => {
      const uploadStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'));
      assert.ok(uploadStep, 'expected an upload-artifact step in the build job');
      assert.equal(uploadStep.with && uploadStep.with.overwrite, true);
    });

    // NIT 5: force-with-lease leases on build's OWN observed EXISTING_SHA
    // (passed as a job output), using git's CREATE-ONLY lease form
    // (`refs/heads/$BR:` with an empty expected value) when that output is
    // empty.
    test('build emits existing_sha as a job output; push leases on it (create-only form when empty, NIT 5)', () => {
      const build = wf.jobs && wf.jobs.build;
      assert.equal(build.outputs && build.outputs.existing_sha, '${{ steps.branch.outputs.existing_sha }}');
      const reconcileStep = steps.find((s) => typeof s.run === 'string' && /git checkout -B "\$BR" origin\/next/.test(s.run));
      assert.match(reconcileStep.run, /existing_sha=\$EXISTING_SHA/);

      const pushStep = findStep(pushSteps, 'Push the built branch').step;
      assert.ok(pushStep, 'expected a "Push the built branch" step');
      assert.equal(pushStep.env && pushStep.env.EXISTING_SHA, "${{ needs.build.outputs.existing_sha }}");
      assert.match(pushStep.run, /force-with-lease="refs\/heads\/\$BR:\$EXISTING_SHA"/);
      assert.match(pushStep.run, /force-with-lease="refs\/heads\/\$BR:"/, 'expected the create-only lease form (empty expected value) for a not-yet-existing branch');
      assert.doesNotMatch(pushStep.run, /git push --force\s+origin/, 'must never fall back to a bare --force');
    });

    // NIT 6: "Open or update PR" derives SHORT_SHA from the branch name
    // build actually produced, never a fresh git read.
    test('"Open or update PR" derives SHORT_SHA from needs.build.outputs.branch, no checkout/git read (NIT 6)', () => {
      const openStep = findStep(pushSteps, 'Open or update PR').step;
      assert.ok(openStep, 'expected an "Open or update PR" step');
      assert.match(openStep.run, /SHORT_SHA=\$\{BR#chore\/backmerge-main-to-next-\}/);
      assert.doesNotMatch(openStep.run, /git rev-parse/, '"Open or update PR" must not read git directly');
    });

    // MAJOR 2: the no-op path skips ONLY bundle+push; "Open or update PR" +
    // labels + superseded-close still run (idempotent recovery).
    test('"Open or update PR" and "Close superseded" are NOT gated on noop (MAJOR 2)', () => {
      const openStep = findStep(pushSteps, 'Open or update PR').step;
      const supersedeStep = findStep(pushSteps, 'Close superseded back-merge PRs').step;
      assert.ok(openStep && supersedeStep);
      assert.doesNotMatch(typeof openStep.if === 'string' ? openStep.if : '', /noop/);
      assert.doesNotMatch(typeof supersedeStep.if === 'string' ? supersedeStep.if : '', /noop/);
    });

    test('the checkout, download-artifact, verify-bundle, and push steps ARE still gated on noop != \'true\' (MAJOR 2)', () => {
      const checkoutStep = pushSteps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
      const downloadStep = pushSteps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/download-artifact@'));
      const verifyStep = findStep(pushSteps, 'Verify the bundle is a genuine back-merge').step;
      const pushStep = findStep(pushSteps, 'Push the built branch').step;
      for (const step of [checkoutStep, downloadStep, verifyStep, pushStep]) {
        assert.ok(step);
        assert.equal(step.if, "needs.build.outputs.noop != 'true'");
      }
    });

    // SEC LOW, code#7: credential passed via GIT_CONFIG env vars, never `-c`
    // argv (visible via ps/proc); masked before any use.
    test('the push credential is passed via GIT_CONFIG_COUNT/KEY_0/VALUE_0 env vars, never `-c` argv, and is masked first (SEC LOW 7)', () => {
      const pushStep = findStep(pushSteps, 'Push the built branch').step;
      assert.ok(pushStep, 'expected a "Push the built branch" step');
      assert.match(pushStep.run, /GIT_CONFIG_COUNT=1/);
      assert.match(pushStep.run, /GIT_CONFIG_KEY_0=http\.extraheader/);
      assert.match(pushStep.run, /GIT_CONFIG_VALUE_0=/);
      assert.doesNotMatch(pushStep.run, /git\s+-c\s+http\.extraheader/, 'must never pass the header via `-c` (visible on argv)');
      assert.doesNotMatch(
        pushStep.run,
        /https:\/\/x-access-token:\$\{?BOT_TOKEN\}?@github\.com/,
        'the bot token must never be embedded in the push URL',
      );
      const maskIdx = pushStep.run.indexOf('::add-mask::');
      const configIdx = pushStep.run.indexOf('GIT_CONFIG_VALUE_0=');
      assert.ok(maskIdx !== -1 && configIdx !== -1 && maskIdx < configIdx, '::add-mask:: must be issued BEFORE the value is assigned to an env var');
    });

    // SEC INFO, code#8: the trusted script re-verifies the bundle's
    // content-binding BEFORE any push; no npm/install of bundle content.
    describe('SEC INFO 8: push independently re-verifies the bundle via the trusted script before pushing', () => {
      test('the verify step runs identify + verify against a scratch worktree (the push job\'s own trusted checkout)', () => {
        const verifyStep = findStep(pushSteps, 'Verify the bundle is a genuine back-merge').step;
        assert.ok(verifyStep, 'expected a "Verify the bundle is a genuine back-merge..." step');
        assert.match(verifyStep.run, /node scripts\/backmerge-tree\.cjs identify/);
        assert.match(verifyStep.run, /node scripts\/backmerge-tree\.cjs verify/);
        // Round-6 review fix (BLOCKER, code#2): --trusted is GONE entirely —
        // capability-manifest discovery now reads the MERGE COMMIT's own
        // git tree (scripts/backmerge-tree.cjs's listCapabilityManifestsFromTree),
        // never a checkout path.
        assert.doesNotMatch(verifyStep.run, /--trusted\b/, '--trusted was removed; capability discovery no longer needs a checkout path');
        assert.match(verifyStep.run, /git worktree add\b/);
      });

      test('the verify step precedes the push step (step order)', () => {
        const verifyIdx = pushSteps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Verify the bundle is a genuine back-merge'));
        const pushIdx = pushSteps.findIndex((s) => typeof s.name === 'string' && s.name.includes('Push the built branch'));
        assert.notEqual(verifyIdx, -1);
        assert.notEqual(pushIdx, -1);
        assert.ok(verifyIdx < pushIdx, 'the verify step must run before the push step');
      });

      test('no npm ci / npm install / npm run build anywhere in the push job (verify uses node only on the trusted script)', () => {
        for (const s of pushSteps) {
          if (typeof s.run !== 'string') continue;
          assert.doesNotMatch(s.run, /\bnpm (ci|install|run)\b/, `push step "${s.name}" must not run npm`);
        }
      });

      test('a verify failure aborts before any push (exit 1 on VERIFY_STATUS != 0)', () => {
        const verifyStep = findStep(pushSteps, 'Verify the bundle is a genuine back-merge').step;
        assert.match(verifyStep.run, /VERIFY_STATUS[\s\S]{0,20}-ne[\s\S]{0,10}0/);
        assert.match(verifyStep.run, /exit 1/);
      });
    });
  });

  // Round-4 review fix (MAJOR, code#2): no-op when the existing remote
  // branch already has origin/next as an ancestor — no force-push of a new
  // sha when already up to date.
  test('the build job no-ops (does not force-push a new sha) when origin/next is already an ancestor of the existing remote branch', () => {
    const reconcileStep = steps.find((s) => typeof s.run === 'string' && /git checkout -B "\$BR" origin\/next/.test(s.run));
    assert.ok(reconcileStep, 'expected the reconcile step');
    assert.match(reconcileStep.run, /git merge-base --is-ancestor origin\/next "refs\/remotes\/origin\/\$BR"/);
    assert.match(reconcileStep.run, /noop=true/);
    const noopIdx = reconcileStep.run.indexOf('noop=true');
    const checkoutIdx = reconcileStep.run.indexOf('git checkout -B "$BR" origin/next');
    assert.ok(noopIdx !== -1 && checkoutIdx !== -1 && noopIdx < checkoutIdx, 'the no-op check must precede building a new commit');
  });

  // Round-4 review fix (MINOR, code#5): the superseded-PR closer must never
  // drop a human-review marker.
  test('the superseded-PR closer skips PRs labeled needs-manual-review', () => {
    const supersedeStep = findStep(pushSteps, 'Close superseded back-merge PRs').step;
    assert.ok(supersedeStep, 'expected a "Close superseded back-merge PRs" step');
    assert.match(supersedeStep.run, /labels/);
    assert.match(supersedeStep.run, /index\("needs-manual-review"\)\)\s*==\s*null/);
  });

  // Round-4 review fix (LOW, code#6): the now-unreachable GITHUB_TOKEN
  // fallbacks (and the dead `git push origin HEAD` fallback in the
  // version-sync path) are removed entirely.
  test('no step falls back to GITHUB_TOKEN, and no dead `git push origin HEAD` fallback remains', () => {
    const allText = [...steps, ...pushSteps].map((s) => JSON.stringify(s)).join('\n');
    assert.doesNotMatch(allText, /secrets\.GSD_BOT_PR_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN/);
    assert.doesNotMatch(allText, /git push origin HEAD\b/);
  });

  // Round-6 review fixes.
  describe('round-6 review fixes', () => {
    // SEC MEDIUM, code#1: the bundle downloads to a scratch dir OUTSIDE the
    // trusted checkout, and its shape is validated before any use.
    describe('SEC MEDIUM 1: download-artifact path + bundle shape validation', () => {
      test('download-artifact downloads to ${{ runner.temp }}/backmerge-artifact, never the trusted checkout', () => {
        const downloadStep = pushSteps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/download-artifact@'));
        assert.ok(downloadStep, 'expected a download-artifact step');
        assert.equal(downloadStep.with && downloadStep.with.path, '${{ runner.temp }}/backmerge-artifact');
      });

      test('the verify step validates exactly-one-entry, regular-file (not symlink/dir) BEFORE git bundle verify', () => {
        const verifyStep = findStep(pushSteps, 'Verify the bundle is a genuine back-merge').step;
        assert.ok(verifyStep, 'expected a "Verify the bundle is a genuine back-merge..." step');
        assert.match(verifyStep.run, /ENTRY_COUNT[\s\S]{0,20}!=[\s\S]{0,10}"1"/);
        assert.match(verifyStep.run, /-L\s+"\$BUNDLE_PATH"/, 'expected a symlink check');
        assert.match(verifyStep.run, /!\s+-f\s+"\$BUNDLE_PATH"/, 'expected a regular-file check');

        const entryCountIdx = verifyStep.run.indexOf('ENTRY_COUNT=');
        const symlinkIdx = verifyStep.run.indexOf('-L "$BUNDLE_PATH"');
        const regularFileIdx = verifyStep.run.indexOf('! -f "$BUNDLE_PATH"');
        const bundleVerifyIdx = verifyStep.run.indexOf('git bundle verify');
        assert.ok(entryCountIdx !== -1 && bundleVerifyIdx !== -1 && entryCountIdx < bundleVerifyIdx, 'entry-count check must precede git bundle verify');
        assert.ok(symlinkIdx !== -1 && symlinkIdx < bundleVerifyIdx, 'symlink check must precede git bundle verify');
        assert.ok(regularFileIdx !== -1 && regularFileIdx < bundleVerifyIdx, 'regular-file check must precede git bundle verify');
      });

      test('the verify step requires git bundle list-heads to show exactly one head, matching refs/heads/$BR', () => {
        const verifyStep = findStep(pushSteps, 'Verify the bundle is a genuine back-merge').step;
        assert.match(verifyStep.run, /git bundle list-heads\b/);
        assert.match(verifyStep.run, /HEAD_LINE_COUNT[\s\S]{0,20}!=[\s\S]{0,10}"1"/);
        assert.match(verifyStep.run, /HEAD_REF[\s\S]{0,20}!=[\s\S]{0,10}"refs\/heads\/\$BR"/);
        const listHeadsIdx = verifyStep.run.indexOf('git bundle list-heads');
        const fetchIncomingIdx = verifyStep.run.indexOf('${BR}-incoming');
        assert.ok(listHeadsIdx !== -1 && fetchIncomingIdx !== -1 && listHeadsIdx < fetchIncomingIdx, 'list-heads validation must precede fetching the bundle into the checkout');
      });
    });

    // BLOCKER, code#3: gh must work even on the no-op path (no checkout at
    // all), and gh pr list failures must be distinguished from "no PR".
    describe('BLOCKER 3: GH_REPO at job level; gh pr list failure fails loudly', () => {
      test('the push job sets GH_REPO at job level (so gh works with no checkout on the no-op path)', () => {
        assert.equal(wf.jobs.push.env && wf.jobs.push.env.GH_REPO, '${{ github.repository }}');
      });

      test('"Open or update PR" distinguishes a gh pr list API failure from a genuinely empty result', () => {
        const openStep = findStep(pushSteps, 'Open or update PR').step;
        assert.ok(openStep, 'expected an "Open or update PR" step');
        assert.match(openStep.run, /if\s+!\s+LIST_JSON=\$\(gh pr list/);
        assert.match(openStep.run, /::error::gh pr list failed/);
        assert.doesNotMatch(
          openStep.run,
          /gh pr list[^\n]*2>\/dev\/null\s*\|\|\s*echo\s+""/,
          'must never swallow a gh pr list failure into an empty-string "no PR found" result',
        );
      });
    });
  });
});

// #4990: backmerge-merge-when-green.yml — the event-driven merger. Every
// assertion below reads parsed YAML (js-yaml), never .cjs source text.
describe('#4990: backmerge-merge-when-green.yml (event-driven back-merge PR merger)', () => {
  const MERGER_WORKFLOW = 'backmerge-merge-when-green.yml';
  const wf = loadWorkflow(MERGER_WORKFLOW);

  // Derived, not hardcoded: exactly the workflows producing the 7 required
  // contexts in main-protection.json — review fix (MAJOR, code#6, correcting
  // an EARLIER WRONG finding: pull_request_target workflow_run events DO
  // report the PR's real head_branch/head_sha, verified live; ALL 7 are
  // restored to the trigger list, not just the pull_request-triggered 4).
  function requiredContextWorkflowNames() {
    const rulesetPath = path.join(REPO_ROOT, '.github', 'rulesets', 'main-protection.json');
    const ruleset = JSON.parse(fs.readFileSync(rulesetPath, 'utf8'));
    const rule = (ruleset.rules || []).find((r) => r.type === 'required_status_checks');
    assert.ok(rule, 'expected a required_status_checks rule in .github/rulesets/main-protection.json');
    const contexts = (rule.parameters.required_status_checks || []).map((c) => c.context);
    assert.ok(contexts.length > 0);

    const allWorkflowFiles = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));
    const names = new Set();
    for (const context of contexts) {
      let found;
      for (const file of allWorkflowFiles) {
        let doc;
        try {
          doc = loadWorkflow(file);
        } catch {
          continue;
        }
        const hasProducingJob = Object.entries(doc.jobs || {}).some(
          ([jobId, job]) => (job && typeof job.name === 'string' ? job.name : jobId) === context,
        );
        if (hasProducingJob) {
          found = doc;
          break;
        }
      }
      assert.ok(found, `required context "${context}" has no producing workflow`);
      assert.equal(typeof found.name, 'string', `workflow producing "${context}" has no top-level name:`);
      names.add(found.name);
    }
    return names;
  }

  test('triggers on workflow_run for exactly the 7 required-context workflows (all 7, not a subset)', () => {
    const triggers = wf.on || wf[true];
    assert.ok(triggers && triggers.workflow_run, `${MERGER_WORKFLOW} must trigger on workflow_run`);
    assert.deepEqual(triggers.workflow_run.types, ['completed']);

    const configured = new Set(triggers.workflow_run.workflows || []);
    const expected = requiredContextWorkflowNames();
    assert.equal(configured.size, 7, 'must list all 7 required-context workflow NAMEs, including the 3 pull_request_target ones');
    assert.deepEqual(
      [...configured].sort(),
      [...expected].sort(),
      `${MERGER_WORKFLOW}'s workflow_run.workflows must list exactly the workflow NAMEs producing the 7 `
        + 'required contexts in .github/rulesets/main-protection.json',
    );
  });

  test('also triggers on schedule (a sweep/staleness backstop, not just event-driven) and workflow_dispatch', () => {
    const triggers = wf.on || wf[true];
    assert.ok(Array.isArray(triggers.schedule) && triggers.schedule.length > 0, `${MERGER_WORKFLOW} must trigger on schedule`);
    assert.equal(typeof triggers.schedule[0].cron, 'string');
    assert.ok(
      Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch'),
      `${MERGER_WORKFLOW} must trigger on workflow_dispatch`,
    );
  });

  test('no workflow-level concurrency group (review fix: fork-controllable key, queued-run cancellation noise)', () => {
    assert.equal(
      wf.concurrency,
      undefined,
      `${MERGER_WORKFLOW} must not declare a workflow-level concurrency group — the merge is made `
        + 'idempotent instead (re-check state immediately before merging)',
    );
  });

  test('workflow-level permissions are read-only (least privilege)', () => {
    assert.deepEqual(wf.permissions, {
      contents: 'read',
      'pull-requests': 'read',
      checks: 'read',
      statuses: 'read',
      // Round-4 review fix (MAJOR, code#2): needed by the in-flight
      // rebuild guard's `gh run list --workflow auto-backmerge.yml`.
      actions: 'read',
    });
  });

  // Round-5 review fix (MINOR, code#3): back down to TWO jobs — `evaluate`
  // (no environment; GITHUB_TOKEN only; candidate listing through
  // content-binding replay) and `act` (environment: gsd-bot; resolves the
  // bot's own login itself, then merges/dispatches). The round-4 THIRD job,
  // `identity`, is gone — see the module header's BOT-TOKEN ISOLATION
  // section for why (its own step-id reference bug, and "act trusts
  // evaluate" without ever re-verifying). Most assertions below read
  // `evaluate`'s or `act`'s own steps directly; `allRunText`/
  // `allRunTextNoComments`/`allEnvText` span BOTH jobs combined (in
  // job-dependency order: evaluate, then act) for cross-cutting checks.
  const evaluateJob = wf.jobs && wf.jobs.evaluate;
  const actJob = wf.jobs && wf.jobs.act;
  const evaluateSteps = (evaluateJob && evaluateJob.steps) || [];
  const actSteps = (actJob && actJob.steps) || [];
  const steps = evaluateSteps; // legacy alias — most existing assertions concern `evaluate`'s own steps
  const allSteps = [...evaluateSteps, ...actSteps];
  const allRunText = allSteps.map((s) => (typeof s.run === 'string' ? s.run : '')).join('\n---\n');
  // Comment lines stripped: a doc comment describing what NOT to do (e.g.
  // "never `gh pr list --head <branch>`") must not itself trip a check for
  // the pattern it is warning against.
  const allRunTextNoComments = allRunText
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  // env: values across every step (not just run: text) — several assertions
  // below check a GitHub expression that legitimately lives in env:, not
  // run:, by design (CONTRIBUTING.md: no ${{ }} in run:).
  const allEnvText = allSteps.map((s) => JSON.stringify(s.env || {})).join('\n');

  function stepByName(pattern) {
    return allSteps.find((s) => typeof s.name === 'string' && pattern.test(s.name));
  }

  test('the evaluate and act jobs exist; no identity job (round-5 review fix, MINOR, code#3)', () => {
    assert.ok(evaluateJob, 'expected a jobs.evaluate in backmerge-merge-when-green.yml');
    assert.ok(actJob, 'expected a jobs.act in backmerge-merge-when-green.yml');
    assert.equal(wf.jobs && wf.jobs.identity, undefined, 'the identity job must no longer exist');
  });

  test('act depends on evaluate, and only runs when there is at least one action', () => {
    assert.equal(actJob.needs, 'evaluate');
    const cond = typeof actJob.if === 'string' ? actJob.if : '';
    assert.match(cond, /needs\.evaluate\.outputs\.count\s*!=\s*'0'/);
  });

  test('the evaluate job if pins a workflow_run trigger to a same-repo pull_request OR pull_request_target run', () => {
    const condition = typeof evaluateJob.if === 'string' ? evaluateJob.if : '';
    assert.match(condition, /workflow_run\.event\s*==\s*'pull_request'/);
    assert.match(condition, /workflow_run\.event\s*==\s*'pull_request_target'/);
    assert.match(
      condition,
      /head_repository\.full_name\s*==\s*github\.repository/,
      'the job must require github.event.workflow_run.head_repository.full_name == github.repository '
        + 'before touching any secret — a workflow_run from a fork must never reach the merge',
    );
  });

  test('the evaluate job if also allows schedule and workflow_dispatch (the sweep)', () => {
    const condition = typeof evaluateJob.if === 'string' ? evaluateJob.if : '';
    assert.match(condition, /event_name\s*==\s*'schedule'/);
    assert.match(condition, /event_name\s*==\s*'workflow_dispatch'/);
  });

  test('the PR is resolved via workflow_run.pull_requests[0].number, never gh pr list --head + .[0]', () => {
    assert.match(
      allEnvText,
      /workflow_run\.pull_requests\[0\]\.number/,
      'expected the candidate-list step to bind github.event.workflow_run.pull_requests[0].number via '
        + 'env: (populated only for same-repo PRs)',
    );
    assert.doesNotMatch(
      allRunTextNoComments,
      /gh pr list[^\n]*--head\b/,
      'must never resolve the PR via `gh pr list --head <branch>` + `.[0]` — ambiguous on a branch-name '
        + 'collision or reopened history',
    );
  });

  // Round-5 review fix (MINOR, code#3): evaluate holds no bot identity
  // (GITHUB_TOKEN only) — the sweep can no longer filter by --author. It
  // instead lists every open PR to next and structurally pre-filters on the
  // deterministic head-branch prefix; --limit 1000 so pagination can never
  // silently truncate the list.
  test('the sweep lists PRs by base=next (no --author — evaluate holds no identity) and pre-filters by the head-branch prefix, --limit 1000', () => {
    const candidatesStep = findStep(evaluateSteps, 'Build the candidate PR list').step;
    assert.ok(candidatesStep, 'expected a "Build the candidate PR list" step');
    // Comment-stripped: the step's own doc comment legitimately MENTIONS
    // "--author" prose (explaining what it no longer does), which must not
    // itself trip a check for the real flag.
    const codeOnly = candidatesStep.run.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(codeOnly, /--author\b/, 'evaluate must never filter by --author — it holds no bot identity');
    assert.match(candidatesStep.run, /gh pr list[\s\S]{0,160}--base\s+next\b/);
    assert.match(candidatesStep.run, /gh pr list[\s\S]{0,200}--limit\s+1000\b/);
    assert.match(candidatesStep.run, /startswith\("chore\/backmerge-main-to-next-"\)/);
  });

  test('no step checks out a non-default ref (never the PR head), and the trusted checkout uses path: trusted', () => {
    const checkoutSteps = steps.filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    assert.ok(checkoutSteps.length >= 1, 'expected at least one actions/checkout step');
    for (const step of checkoutSteps) {
      const ref = step.with && step.with.ref;
      assert.equal(
        ref,
        undefined,
        'every checkout step in this job must omit `ref:` entirely (default branch) — never check out '
          + 'github.event.workflow_run.head_sha or any other PR-controlled ref',
      );
      assert.equal(step.with && step.with['persist-credentials'], false, 'checkout must not persist credentials');
      assert.equal(step.with && step.with.path, 'trusted', 'review fix (CRITICAL, code#3): the trusted checkout must live at a dedicated, named path');
    }
  });

  test('no run: block interpolates a GitHub expression — every event field is passed through env:', () => {
    // CONTRIBUTING.md: no ${{ }} in run: blocks; doubly load-bearing here
    // since github.event.workflow_run.* fields are attacker-influenceable.
    for (const step of allSteps) {
      if (typeof step.run !== 'string') continue;
      assert.ok(
        !step.run.includes('${{'),
        `step "${step.name || '(unnamed)'}" interpolates a GitHub expression directly in run: — bind it `
          + 'via env: instead',
      );
    }
  });

  test('the bot identity is resolved with GSD_BOT_PR_TOKEN and NO GITHUB_TOKEN fallback', () => {
    const identityStep = stepByName(/bot identity/i);
    assert.ok(identityStep, 'expected an identity-resolution step');
    const ghToken = identityStep.env && identityStep.env.GH_TOKEN;
    assert.equal(ghToken, "${{ secrets.GSD_BOT_PR_TOKEN }}", 'identity resolution must use ONLY the bot token');
    assert.match(identityStep.run, /gh api user/);
    assert.match(identityStep.run, /::error::/, 'must fail loudly when the bot token is absent');
  });

  // Review fix (CRITICAL, code#3, "bot token must never be in the env of a
  // step that runs node/git on PR-derived content"): the evaluation step —
  // the one that runs scripts/backmerge-tree.cjs and
  // scripts/ci-required-checks-verdict.cjs against candidate PR content —
  // must be GITHUB_TOKEN only.
  describe('BOT-TOKEN ISOLATION (review fix, CRITICAL, code#3)', () => {
    test('the evaluation step (runs node/git on PR content) uses GITHUB_TOKEN only — no bot token', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.ok(evaluateStep, 'expected an "Evaluate every candidate" step');
      const env = JSON.stringify(evaluateStep.env || {});
      assert.match(env, /secrets\.GITHUB_TOKEN/);
      assert.doesNotMatch(env, /GSD_BOT_PR_TOKEN/, 'the evaluation step must never see the bot token');
      assert.match(evaluateStep.run, /backmerge-tree\.cjs/);
      assert.match(evaluateStep.run, /ci-required-checks-verdict\.cjs/);
    });

    test('the bot token appears in at most two steps across both jobs: identity (inside act), and the merge/dispatch step', () => {
      const botTokenSteps = allSteps.filter((s) => JSON.stringify(s.env || {}).includes('GSD_BOT_PR_TOKEN'));
      const names = botTokenSteps.map((s) => s.name);
      assert.ok(names.length <= 2, `expected at most 2 steps with the bot token in env, found: ${names.join(', ')}`);
      for (const name of names) {
        assert.match(name, /bot identity|Merge eligible/i);
      }
    });

    test('the merge/dispatch step never runs node or a git checkout of PR content', () => {
      const mergeStep = stepByName(/^Merge eligible PRs/);
      assert.ok(mergeStep, 'expected a "Merge eligible PRs" step');
      assert.doesNotMatch(mergeStep.run, /\bnode\b/, 'the bot-token step must never invoke node against PR content');
      assert.doesNotMatch(mergeStep.run, /git checkout/, 'the bot-token step must never checkout PR content');
    });
  });

  // Review fix (CRITICAL, code#3, "checkout the default branch into a
  // dedicated path and never modify it ... all replay/verify work happens
  // in a separate scratch git worktree add").
  describe('TRUST BOUNDARY (review fix, CRITICAL, code#3)', () => {
    test('scripts are invoked from the trusted/ checkout, never a bare relative path', () => {
      assert.match(allRunTextNoComments, /node trusted\/scripts\/backmerge-tree\.cjs/);
      assert.match(allRunTextNoComments, /node trusted\/scripts\/ci-required-checks-verdict\.cjs/);
      assert.match(allRunTextNoComments, /--required-from trusted\/\.github\/rulesets\/main-protection\.json/);
    });

    test('a scratch git worktree is created per candidate and passed to backmerge-tree.cjs via --cwd', () => {
      assert.match(allRunTextNoComments, /git -C trusted worktree add\b/);
      assert.match(allRunTextNoComments, /backmerge-tree\.cjs identify[\s\S]{0,120}--cwd\s+"\$SCRATCH"/);
      assert.match(allRunTextNoComments, /backmerge-tree\.cjs verify[\s\S]{0,260}--cwd\s+"\$SCRATCH"/);
    });

    test('the trusted checkout is never reset/checked-out-to (no `git -C trusted checkout`/`reset`/`merge`)', () => {
      // Every `git ... trusted` invocation must be read-only or
      // worktree-management — never `checkout`/`reset`/`merge` directly
      // against the trusted/ directory itself. Allowlisted here (review fix,
      // BLOCKER, code#2, added `rev-parse`/`merge-base` for the BEHIND
      // ancestor re-check) rather than a two-item list, since read-only
      // plumbing reads are fine to add over time — only the DANGEROUS
      // mutating subcommands are what this invariant actually forbids.
      const SAFE_TRUSTED_SUBCOMMANDS = new Set(['fetch', 'worktree', 'rev-parse', 'merge-base']);
      const trustedGitCalls = [...allRunTextNoComments.matchAll(/git\s+-C\s+trusted\s+(\S+)/g)].map((m) => m[1]);
      assert.ok(trustedGitCalls.length > 0, 'expected at least one `git -C trusted ...` call');
      for (const subcommand of trustedGitCalls) {
        assert.ok(
          SAFE_TRUSTED_SUBCOMMANDS.has(subcommand),
          `git -C trusted ${subcommand} is not in the safe/read-only set (${[...SAFE_TRUSTED_SUBCOMMANDS].join(', ')}) — `
            + 'the trusted checkout must never be checked out to, reset, or merged into',
        );
      }
      assert.ok(!trustedGitCalls.includes('checkout'));
      assert.ok(!trustedGitCalls.includes('reset'));
      assert.ok(!trustedGitCalls.includes('merge'));
    });
  });

  // Round-5 review fix (MINOR, code#3): author-binding moved from
  // `evaluate`'s AUTHOR_LOGIN (a cheap, non-authoritative pre-filter that no
  // longer exists — evaluate holds no identity) to `act`'s own
  // RECHECK_AUTHOR — the authoritative, immediate pre-action re-check.
  test('author-binding (RECHECK_AUTHOR, in act) and content-binding (identify + verify, in evaluate) precede the merge', () => {
    const verdictIdx = allRunText.indexOf('ci-required-checks-verdict.cjs');
    const mergeIdx = allRunText.indexOf('gh pr merge');
    const authorBindIdx = allRunText.indexOf('RECHECK_AUTHOR');
    const identifyIdx = allRunText.indexOf('backmerge-tree.cjs identify');
    const verifyIdx = allRunText.indexOf('backmerge-tree.cjs verify');
    for (const [label, idx] of [
      ['author-binding (RECHECK_AUTHOR)', authorBindIdx],
      ['content-binding identify', identifyIdx],
      ['content-binding verify', verifyIdx],
      ['required-checks verdict', verdictIdx],
    ]) {
      assert.notEqual(idx, -1, `expected to find ${label} in the job's run: text`);
      assert.ok(idx < mergeIdx, `${label} must run before the merge`);
    }
  });

  // Round-5 review fix (MINOR, code#3; closes security LOW "act trusts
  // evaluate"): act re-verifies author/cross-repo/base authoritatively,
  // fresh, immediately before acting on ANY recorded action — never trusting
  // evaluate's own (token-free) pre-filter for the actual write decision.
  test('act re-verifies author.login, isCrossRepository, and baseRefName immediately before acting (security LOW fix)', () => {
    const actMergeStep = stepByName(/^Merge eligible PRs/);
    assert.ok(actMergeStep, 'expected a "Merge eligible PRs" step');
    assert.match(actMergeStep.run, /--json[^\n]*\bauthor\b/);
    assert.match(actMergeStep.run, /--json[^\n]*\bisCrossRepository\b/);
    assert.match(actMergeStep.run, /--json[^\n]*\bbaseRefName\b/);
    assert.match(actMergeStep.run, /RECHECK_AUTHOR[\s\S]{0,20}!=[\s\S]{0,10}"\$LOGIN"/);
    assert.match(actMergeStep.run, /RECHECK_CROSS[\s\S]{0,20}!=[\s\S]{0,20}"false"/);
    assert.match(actMergeStep.run, /RECHECK_BASE[\s\S]{0,20}!=[\s\S]{0,20}"next"/);
    // The re-check must be shared across BOTH action types (before the
    // `case "$ACTION" in` dispatch), not duplicated/omitted for `rebuild`.
    const caseIdx = actMergeStep.run.indexOf('case "$ACTION" in');
    const authorCheckIdx = actMergeStep.run.indexOf('RECHECK_AUTHOR');
    assert.ok(caseIdx !== -1 && authorCheckIdx !== -1 && authorCheckIdx < caseIdx);
  });

  test('the verdict script is invoked with --sha and --required-from', () => {
    // The invocation spans multiple lines (a `\`-continued shell command),
    // so this matches across newlines rather than anchoring to one line.
    assert.match(allRunText, /ci-required-checks-verdict\.cjs[\s\S]{0,200}--sha\b/);
    assert.match(allRunText, /ci-required-checks-verdict\.cjs[\s\S]{0,200}--required-from\b/);
  });

  // #4990 review fix: content-binding used to be a SECOND, hand-kept bash
  // copy of auto-backmerge.yml's tree-construction logic — exactly the
  // "Generative Fix Divergence" CLAUDE.md forbids. Both workflows must call
  // the ONE shared script instead of re-implementing it.
  test('content-binding uses the shared scripts/backmerge-tree.cjs identify+verify subcommands, not a hand-kept bash replay', () => {
    assert.match(allRunTextNoComments, /backmerge-tree\.cjs\s+identify\b/);
    assert.match(allRunTextNoComments, /backmerge-tree\.cjs\s+verify\b/);
    assert.match(allRunText, /backmerge-tree\.cjs verify[\s\S]{0,120}--next\b/);
    assert.match(allRunText, /backmerge-tree\.cjs verify[\s\S]{0,200}--merge-commit\b/);
    assert.match(allRunText, /backmerge-tree\.cjs verify[\s\S]{0,260}--head\b/);
    assert.doesNotMatch(
      allRunTextNoComments,
      /merge\s+-s\s+ours/,
      'the merge -s ours tree construction must not be re-implemented in this workflow\'s own bash — '
        + 'it must call scripts/backmerge-tree.cjs, the one shared source',
    );
    assert.doesNotMatch(
      allRunTextNoComments,
      /git log --merges/,
      'review fix (MEDIUM, code#4): the merge commit must be identified by scripts/backmerge-tree.cjs '
        + 'identify (its expected two-parent SHAPE), never by `git log --merges -1` (searches all of '
        + 'history for the most recent merge commit, which can find the wrong one)',
    );
  });

  test('the merge uses --match-head-commit and the bot token with no GITHUB_TOKEN fallback', () => {
    assert.match(allRunText, /gh pr merge[^\n]*--admin/);
    assert.match(allRunText, /gh pr merge[\s\S]{0,80}--match-head-commit\b/);
    // Never `secrets.GSD_BOT_PR_TOKEN || secrets.GITHUB_TOKEN` anywhere in
    // the job — the bot token has no fallback.
    assert.doesNotMatch(
      allRunText,
      /secrets\.GSD_BOT_PR_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN/,
      'no step may fall back to GITHUB_TOKEN when the bot token is unset — GITHUB_TOKEN cannot admin-merge anyway',
    );
  });

  // Review fix (BLOCKER, MEDIUM, code#4): `gh pr update-branch` creates a
  // merge commit that breaks the exact two-parent shape content-binding
  // depends on — BEHIND must dispatch a REBUILD (gh workflow run
  // auto-backmerge.yml) instead.
  test('BEHIND dispatches a rebuild of auto-backmerge.yml — never `gh pr update-branch`', () => {
    assert.doesNotMatch(allRunTextNoComments, /gh pr update-branch/);
    assert.match(allRunTextNoComments, /gh workflow run auto-backmerge\.yml/);
  });

  test('the merge is idempotent: re-checks state/head immediately before merging', () => {
    assert.match(allRunText, /RECHECK/);
    assert.match(allRunText, /already merged at the verified sha|already MERGED at the verified sha/i);
  });

  // Round-6 review fix (MINOR, code#7 / SEC LOW): the staleness age
  // threshold is still computed in `evaluate` (BACKMERGE_PR_STALENESS_AGE_HOURS),
  // but the alarm itself (the ::error:: that fails the job) moved to `act`'s
  // `stale` case — evaluate holds no bot identity, so it can only RECORD a
  // `stale` candidate; only `act` (which re-verifies real authorship) is
  // authoritative enough to raise the alarm. See the dedicated "round-6
  // review fixes" describe block below for the full ordering/author-check
  // assertions on this behavior.
  test('a staleness backstop fails the job loudly for an open back-merge PR past the documented age', () => {
    assert.match(allRunText, /BACKMERGE_PR_STALENESS_AGE_HOURS/);
    assert.match(allRunText, /printf 'stale\\t%s\\t%s\\n' "\$PR" "\$CREATED_AT" >> actions\.txt/);
    assert.match(allRunText, /::error::[^\n]*past the documented staleness age[^\n]*not merged/);
  });

  // Review fix (MINOR, code#11): cheap eligibility work (candidate listing,
  // which needs only the bot identity + a `gh pr list`/payload read) must
  // precede the expensive trusted checkout/fetch — asserted by STEP ORDER.
  test('the candidate list is built BEFORE the expensive trusted checkout/fetch (efficiency, code#11)', () => {
    const candidatesIdx = steps.findIndex((s) => s.id === 'candidates');
    const checkoutIdx = steps.findIndex((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    const fetchIdx = steps.findIndex((s) => typeof s.name === 'string' && /Fetch main and next/.test(s.name));
    assert.notEqual(candidatesIdx, -1);
    assert.notEqual(checkoutIdx, -1);
    assert.notEqual(fetchIdx, -1);
    assert.ok(candidatesIdx < checkoutIdx, 'candidate listing must precede the trusted checkout');
    assert.ok(candidatesIdx < fetchIdx, 'candidate listing must precede the fetch');
    // Both the checkout and fetch must be gated on "at least one candidate".
    assert.equal(steps[checkoutIdx].if, "steps.candidates.outputs.count != '0'");
    assert.equal(steps[fetchIdx].if, "steps.candidates.outputs.count != '0'");
  });

  // #4990 round-3 review fixes, asserted directly against the real workflow
  // rather than only smoke-verified — locks each one in against regression.
  describe('round-3 review fixes', () => {
    // Round-5 review fix (MINOR, code#3): only `act` runs behind
    // `environment: gsd-bot` now — no separate `identity` job exists;
    // `evaluate` deliberately has NO environment (see the module header's
    // BOT-TOKEN ISOLATION section).
    test('act runs behind environment: gsd-bot; evaluate has no environment (sec HIGH, bot-token exposure)', () => {
      assert.equal(actJob.environment, 'gsd-bot');
      assert.equal(evaluateJob.environment, undefined);
    });

    // Round-4 review fix (NIT 9, now expressed at JOB level): asserted above
    // in the "act depends on evaluate" test; this test additionally locks in
    // the "at least one action" gate.
    test("the act job's if: also gates on at least one merge/rebuild action existing (NIT 9)", () => {
      const cond = typeof actJob.if === 'string' ? actJob.if : '';
      assert.match(cond, /needs\.evaluate\.outputs\.count\s*!=\s*'0'/);
    });

    test('the evaluation step queries headRefName and reviewDecision, and refuses CHANGES_REQUESTED (MINOR 4)', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.ok(evaluateStep, 'expected an "Evaluate every candidate" step');
      assert.match(evaluateStep.run, /--json[^\n]*\bheadRefName\b/);
      assert.match(evaluateStep.run, /--json[^\n]*\breviewDecision\b/);
      assert.match(evaluateStep.run, /REVIEW_DECISION[\s\S]{0,40}=\s*\$\(printf[^\n]*\.reviewDecision/);
      assert.match(evaluateStep.run, /"\$REVIEW_DECISION"\s*=\s*"CHANGES_REQUESTED"/);
    });

    test('the BEHIND branch no-ops when origin/next is already an ancestor, before dispatching a rebuild (BLOCKER 2)', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.match(
        evaluateStep.run,
        /git -C trusted merge-base --is-ancestor origin\/next "refs\/remotes\/origin\/\$HEAD_REF_NAME"/,
      );
      // The ancestor check must come BEFORE the "recording a rebuild dispatch" line.
      const ancestorIdx = evaluateStep.run.indexOf('merge-base --is-ancestor origin/next');
      const rebuildIdx = evaluateStep.run.indexOf('recording a rebuild dispatch');
      assert.notEqual(ancestorIdx, -1);
      assert.notEqual(rebuildIdx, -1);
      assert.ok(ancestorIdx < rebuildIdx, 'the ancestor-already-holds check must precede the rebuild recording');
    });

    test('the BEHIND branch also checks for a queued/in_progress auto-backmerge run before dispatching a rebuild (BLOCKER 2)', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.match(evaluateStep.run, /gh run list[\s\S]{0,80}--workflow auto-backmerge\.yml[\s\S]{0,80}--json status/);
      assert.match(evaluateStep.run, /queued.*in_progress|in_progress.*queued/);
      const runningIdx = evaluateStep.run.indexOf('gh run list');
      const rebuildIdx = evaluateStep.run.indexOf('recording a rebuild dispatch');
      assert.ok(runningIdx !== -1 && rebuildIdx !== -1 && runningIdx < rebuildIdx);
    });

    test('the scratch worktree add is guarded (per-PR failure isolation, MINOR 6) and uses GIT_LFS_SKIP_SMUDGE=1 (sec LOW)', () => {
      const heavyWorkText = allRunTextNoComments;
      assert.match(
        heavyWorkText,
        /if\s+!\s+GIT_LFS_SKIP_SMUDGE=1 git -C trusted worktree add\b/,
        'expected the scratch worktree add to be guarded (if ! ...) and prefixed with GIT_LFS_SKIP_SMUDGE=1',
      );
    });

    test('a `gh pr view` failure for one PR candidate is recorded and the loop continues (per-PR failure isolation, MINOR 6)', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.match(evaluateStep.run, /if\s+!\s+PR_JSON=\$\(gh pr view/);
      assert.match(evaluateStep.run, /FAILED=1/);
      assert.match(evaluateStep.run, /continue/);
    });

    test('the immediate pre-merge re-check requires mergeStateStatus in {CLEAN,BLOCKED} and rejects CHANGES_REQUESTED (MINOR 4)', () => {
      const mergeStep = stepByName(/^Merge eligible PRs/);
      assert.match(mergeStep.run, /--json[^\n]*\bmergeStateStatus\b/);
      assert.match(mergeStep.run, /--json[^\n]*\breviewDecision\b/);
      assert.match(mergeStep.run, /RECHECK_MERGE_STATE[\s\S]{0,20}!=[\s\S]{0,20}"CLEAN"[\s\S]{0,40}RECHECK_MERGE_STATE[\s\S]{0,20}!=[\s\S]{0,20}"BLOCKED"/);
      assert.match(mergeStep.run, /RECHECK_REVIEW_DECISION[\s\S]{0,20}=\s*"CHANGES_REQUESTED"/);
    });
  });

  // Round-4 review fixes.
  describe('round-4 review fixes', () => {
    test('a failed `gh run list` is treated as UNKNOWN and does NOT dispatch a rebuild (fail closed, MAJOR 2)', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.match(evaluateStep.run, /if\s+!\s+RUNNING_JSON=\$\(gh run list/);
      const failClosedIdx = evaluateStep.run.indexOf('treating in-flight rebuild status as UNKNOWN');
      assert.notEqual(failClosedIdx, -1, 'expected the fail-closed UNKNOWN warning on a gh run list failure');
      assert.doesNotMatch(
        evaluateStep.run,
        /RUNNING=\$\(gh run list[^\n]*\|\|\s*echo\s+"0"/,
        'must not silently default to "0 running" (dispatch-permitting) on a gh run list failure',
      );
    });

    test('every non-completed run status counts toward the in-flight guard (status != "completed", not a hand-enumerated allowlist, MAJOR 2)', () => {
      const evaluateStep = stepByName(/^Evaluate every candidate/);
      assert.match(evaluateStep.run, /select\(\.status\s*!=\s*"completed"\)/);
    });

    test('evaluate emits actions.txt as a job output (never a secret, never an artifact); act reconstructs it from that output (MINOR 3)', () => {
      const emitStep = stepByName(/^Emit actions for the act job/);
      assert.ok(emitStep, 'expected an "Emit actions for the act job" step in evaluate');
      assert.match(emitStep.run, /count=/);
      assert.match(emitStep.run, /actions<</);
      assert.equal(evaluateJob.outputs && evaluateJob.outputs.count, '${{ steps.emit.outputs.count }}');
      assert.equal(evaluateJob.outputs && evaluateJob.outputs.actions, '${{ steps.emit.outputs.actions }}');

      const reconstructStep = findStep(actSteps, "Reconstruct actions.txt from the evaluate job's output").step;
      assert.ok(reconstructStep, 'expected a "Reconstruct actions.txt..." step in act');
      assert.equal(reconstructStep.env && reconstructStep.env.ACTIONS, '${{ needs.evaluate.outputs.actions }}');
    });
  });

  // Round-6 review fixes.
  describe('round-6 review fixes', () => {
    // MINOR, code#7 / SEC LOW: the staleness alarm must only ever fire for
    // bot-authored PRs — evaluate (no identity) records `stale` candidates;
    // act (which resolves the login) applies the author filter and raises
    // the alarm.
    describe('MINOR 7 / SEC LOW: staleness alarm is author-authoritative (raised by act, not evaluate)', () => {
      test('evaluate records a `stale` action instead of alarming directly, and never sets FAILED for staleness', () => {
        const evaluateStep = stepByName(/^Evaluate every candidate/);
        assert.match(evaluateStep.run, /printf 'stale\\t%s\\t%s\\n' "\$PR" "\$CREATED_AT" >> actions\.txt/);
        // The staleness block itself must not directly raise ::error:: or
        // set FAILED=1 — only record the candidate.
        const stalenessBlockStart = evaluateStep.run.indexOf('STALENESS BACKSTOP');
        const stalenessBlockEnd = evaluateStep.run.indexOf('if [ "$FAILED" -ne 0 ]', stalenessBlockStart);
        assert.ok(stalenessBlockStart !== -1 && stalenessBlockEnd !== -1 && stalenessBlockStart < stalenessBlockEnd);
        // Comment-stripped: this block's own doc comment explains "no
        // FAILED=1 here anymore" in prose, which must not itself trip a
        // check for the real (absent) assignment.
        const stalenessBlockCodeOnly = evaluateStep.run
          .slice(stalenessBlockStart, stalenessBlockEnd)
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n');
        assert.doesNotMatch(stalenessBlockCodeOnly, /::error::/, 'evaluate must not raise the staleness alarm itself — it holds no bot identity to authoritatively confirm authorship');
        assert.doesNotMatch(stalenessBlockCodeOnly, /FAILED=1/);
      });

      test('act raises the staleness alarm only after the shared author/cross-repo/base re-check, and only if still OPEN', () => {
        const mergeStep = stepByName(/^Merge eligible PRs/);
        assert.ok(mergeStep, 'expected a "Merge eligible PRs" step');
        assert.match(mergeStep.run, /stale\)/);
        const staleCaseIdx = mergeStep.run.indexOf('stale)');
        const authorCheckIdx = mergeStep.run.indexOf('RECHECK_AUTHOR');
        assert.ok(authorCheckIdx !== -1 && staleCaseIdx !== -1 && authorCheckIdx < staleCaseIdx, 'the author re-check must precede the stale case branch (shared pre-check)');
        const staleCaseText = mergeStep.run.slice(staleCaseIdx);
        assert.match(staleCaseText, /RECHECK_STATE[\s\S]{0,20}=[\s\S]{0,10}"OPEN"/);
        assert.match(staleCaseText, /::error::[\s\S]{0,200}staleness/i);
        assert.match(staleCaseText, /MERGE_FAILED=1/);
      });

      test("act's if: covers both real actions and stale candidates (unified count)", () => {
        const cond = typeof actJob.if === 'string' ? actJob.if : '';
        assert.match(cond, /needs\.evaluate\.outputs\.count\s*!=\s*'0'/, 'the SAME count output covers both merge/rebuild actions and stale candidates');
      });
    });

    // MINOR, code#8: per-PR failure isolation for act's immediate
    // pre-action re-check.
    test('act\'s RECHECK is guarded (per-PR failure isolation, MINOR 8) — a failure records and continues, never aborts the loop', () => {
      const mergeStep = stepByName(/^Merge eligible PRs/);
      assert.match(mergeStep.run, /if\s+!\s+RECHECK=\$\(gh pr view/);
      const guardIdx = mergeStep.run.indexOf('if ! RECHECK=$(gh pr view');
      const failedIdx = mergeStep.run.indexOf('MERGE_FAILED=1', guardIdx);
      const continueIdx = mergeStep.run.indexOf('continue', guardIdx);
      assert.ok(guardIdx !== -1 && failedIdx !== -1 && continueIdx !== -1 && failedIdx < continueIdx);
    });

    // NIT, code#9: act re-reads labels and refuses needs-manual-review.
    test('act re-checks labels and refuses needs-manual-review for merge/rebuild immediately before acting (NIT 9)', () => {
      const mergeStep = stepByName(/^Merge eligible PRs/);
      assert.match(mergeStep.run, /--json[^\n]*\blabels\b/);
      assert.match(mergeStep.run, /RECHECK_HAS_NEEDS_REVIEW/);
      assert.match(mergeStep.run, /index\("needs-manual-review"\)\)\s*!=\s*null/);
      assert.match(mergeStep.run, /RECHECK_HAS_NEEDS_REVIEW[\s\S]{0,20}=[\s\S]{0,10}"true"/);
    });

    // Round-7 review fix (MINOR): needs-manual-review refuses ONLY
    // merge/rebuild — never `stale`, which must still be able to alarm on a
    // bot PR sitting on a human-review label (exactly the PR class most
    // likely to need the alarm).
    test('needs-manual-review refusal applies ONLY to merge/rebuild, never to stale — stale still alarms after the shared author/cross-repo/base checks', () => {
      const mergeStep = stepByName(/^Merge eligible PRs/);
      const run = mergeStep.run;
      const staleIdx = run.indexOf('stale)');
      const rebuildIdx = run.indexOf('rebuild)');
      const mergeIdx = run.indexOf('merge)');
      assert.ok(staleIdx !== -1 && rebuildIdx !== -1 && mergeIdx !== -1 && staleIdx < rebuildIdx && rebuildIdx < mergeIdx);

      // The shared pre-check block (before the `case` statement) must NOT
      // refuse on needs-manual-review — only author/cross-repo/base.
      const sharedPreCheck = run.slice(0, staleIdx);
      assert.doesNotMatch(
        sharedPreCheck,
        /RECHECK_HAS_NEEDS_REVIEW[\s\S]{0,20}=[\s\S]{0,10}"true"/,
        'needs-manual-review must not be refused in the shared pre-check — it would silently suppress the stale alarm too',
      );

      const staleBlock = run.slice(staleIdx, rebuildIdx);
      assert.doesNotMatch(staleBlock, /RECHECK_HAS_NEEDS_REVIEW/, 'the stale case must never check needs-manual-review');
      assert.match(staleBlock, /RECHECK_STATE[\s\S]{0,20}=[\s\S]{0,10}"OPEN"/, 'stale still gates on the PR being OPEN');
      assert.match(staleBlock, /::error::/, 'stale must still be able to raise the alarm');

      const rebuildBlock = run.slice(rebuildIdx, mergeIdx);
      assert.match(rebuildBlock, /RECHECK_HAS_NEEDS_REVIEW[\s\S]{0,20}=[\s\S]{0,10}"true"/, 'rebuild must refuse on needs-manual-review');

      const mergeBlock = run.slice(mergeIdx);
      assert.match(mergeBlock, /RECHECK_HAS_NEEDS_REVIEW[\s\S]{0,20}=[\s\S]{0,10}"true"/, 'merge must refuse on needs-manual-review');
    });
  });
});

describe('#4990 round-3: auto-backmerge.yml bot-token push + superseded-PR cleanup', () => {
  const wf = loadWorkflow('auto-backmerge.yml');
  // Round-4 review fix (MEDIUM, code#4): split into build/push — the
  // superseded-PR closer and "Open or update PR" now live in `push`.
  const job = wf.jobs && wf.jobs.push;
  const steps = job.steps;

  test('the push job runs behind environment: gsd-bot (sec HIGH, bot-token exposure)', () => {
    assert.equal(job.environment, 'gsd-bot');
  });

  test('the checkout step does not persist credentials (REBUILD PATH, code BLOCKER 1)', () => {
    const checkoutStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    assert.ok(checkoutStep, 'expected a checkout step');
    assert.equal(checkoutStep.with && checkoutStep.with['persist-credentials'], false);
  });

  // Round-6 review fix (SEC LOW, code#7): the push authenticates via
  // GIT_CONFIG_COUNT/KEY_0/VALUE_0 env vars, never `-c http.extraheader`
  // (visible on argv) and never a token embedded in the push URL. Round-5
  // review fix (NIT, code#5): force-with-lease now leases on `build`'s OWN
  // observed `existing_sha` job output (never a fresh local
  // `git rev-parse`), using git's create-only lease form when empty — see
  // the dedicated "round-5 review fixes" describe block above for the full
  // assertion; this test locks in the surrounding no-GITHUB_TOKEN-fallback
  // shape on the SAME step, "Push the built branch".
  test('the push uses the bot token only (no GITHUB_TOKEN fallback), with force-with-lease against build\'s existing_sha output (BLOCKER 1, NIT 10)', () => {
    const pushStep = findStep(steps, 'Push the built branch').step;
    assert.ok(pushStep, 'expected a "Push the built branch" step');
    assert.equal(pushStep.env && pushStep.env.BOT_TOKEN, '${{ secrets.GSD_BOT_PR_TOKEN }}');
    assert.doesNotMatch(
      JSON.stringify(pushStep.env || {}),
      /GITHUB_TOKEN/,
      'the push step must never fall back to GITHUB_TOKEN — a GITHUB_TOKEN-authenticated push never re-triggers workflows',
    );
    assert.doesNotMatch(
      pushStep.run,
      /secrets\.GITHUB_TOKEN|GSD_BOT_PR_TOKEN\s*\|\|/,
      'the push must not fall back to GITHUB_TOKEN when the bot token is unset (the step already hard-fails via exit 1 above instead)',
    );
    assert.equal(pushStep.env && pushStep.env.EXISTING_SHA, '${{ needs.build.outputs.existing_sha }}');
    assert.match(pushStep.run, /force-with-lease="refs\/heads\/\$BR:\$EXISTING_SHA"/);
    assert.match(pushStep.run, /force-with-lease="refs\/heads\/\$BR:"/, 'expected the create-only lease form when existing_sha is empty');
    assert.doesNotMatch(pushStep.run, /git push --force\s+origin/, 'must never fall back to a bare --force');
  });

  test('opening/updating a PR closes older open bot-authored same-repo chore/backmerge-* PRs with a comment naming the superseding PR (MAJOR 3)', () => {
    const supersedeStep = findStep(steps, 'Close superseded back-merge PRs').step;
    assert.ok(supersedeStep, 'expected a "Close superseded back-merge PRs" step');
    assert.match(supersedeStep.run, /--author\s+"\$BOT_LOGIN"/);
    assert.match(supersedeStep.run, /isCrossRepository\s*==\s*false/);
    assert.match(supersedeStep.run, /chore\/backmerge-main-to-next-\*/);
    assert.match(supersedeStep.run, /gh pr close "\$OLD_PR"/);
    assert.match(supersedeStep.run, /Superseded by #\$CURRENT_PR/);
    const openIdx = findStep(steps, 'Open or update PR').index;
    const supersedeIdx = findStep(steps, 'Close superseded back-merge PRs').index;
    assert.ok(openIdx < supersedeIdx, 'the superseded-PR cleanup must run after opening/updating the current PR');
  });
});

describe('#4990 round-3: version-sync shape single-sourced from VERSIONED_MANIFESTS (sec MEDIUM)', () => {
  test('scripts/backmerge-tree.cjs requires (single-sources) sync-manifest-versions.cjs and sync-next-version.cjs, never a hand-kept duplicate list', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'backmerge-tree.cjs'), 'utf8');
    assert.match(src, /require\(['"]\.\/sync-manifest-versions\.cjs['"]\)/);
    assert.match(src, /VERSIONED_MANIFESTS/);
    assert.match(src, /require\(['"]\.\/sync-next-version\.cjs['"]\)/);
    assert.match(src, /isReleaseVersion/);
  });
});

describe('#4990 round-3: bot-token exposure (sec HIGH) — environment gating across the other bot-token workflows', () => {
  // Confirms, by parsing the real workflow YAML, exactly which jobs use
  // GSD_BOT_PR_TOKEN and whether each carries `environment: gsd-bot` — or,
  // for release.yml, documents the pre-existing `environment: npm-publish`
  // conflict rather than silently overwriting it.
  function jobsUsingBotToken(wf) {
    return Object.entries(wf.jobs || {}).filter(([, job]) => JSON.stringify(job).includes('GSD_BOT_PR_TOKEN'));
  }

  test('ci-timeout-report.yml: the only bot-token job (report) carries environment: gsd-bot', () => {
    const wf = loadWorkflow('ci-timeout-report.yml');
    const users = jobsUsingBotToken(wf);
    assert.equal(users.length, 1);
    const [[jobId, job]] = users;
    assert.equal(jobId, 'report');
    assert.equal(job.environment, 'gsd-bot');
  });

  test('release.yml: the two bot-token jobs (rc, finalize) already carry environment: npm-publish (documented conflict — not overwritten)', () => {
    const wf = loadWorkflow('release.yml');
    const users = jobsUsingBotToken(wf);
    const jobIds = users.map(([id]) => id).sort();
    assert.deepEqual(jobIds, ['finalize', 'rc']);
    for (const [, job] of users) {
      assert.equal(
        job.environment,
        'npm-publish',
        'release.yml only allows one environment: per job — rc/finalize keep their existing npm-publish environment '
          + '(#4990 round-3: adding gsd-bot here would silently remove npm-publish protection; a maintainer decision, not code-changed)',
      );
    }
  });

  test('dependabot-vendor-refresh.yml: the one bot-token job (refresh-vendor) intentionally has NO environment: gsd-bot (documented Dependabot-secrets gap — not code-changed)', () => {
    const wf = loadWorkflow('dependabot-vendor-refresh.yml');
    const users = jobsUsingBotToken(wf);
    assert.equal(users.length, 1);
    const [[jobId, job]] = users;
    assert.equal(jobId, 'refresh-vendor');
    assert.equal(
      job.environment,
      undefined,
      'refresh-vendor deliberately has no environment: gsd-bot — Dependabot-triggered pull_request runs receive '
        + 'no Actions secrets at all, so an environment secret would not restore access either (#4990 round-3, documented not fixed)',
    );
  });

  // Round-4 review fix (MEDIUM, code#4) renamed auto-backmerge.yml's single
  // `backmerge` job to `build`/`push` (only `push` holds the token); round-5
  // review fix (MINOR, code#3) removed backmerge-merge-when-green.yml's
  // `merge-if-green` job in favor of `evaluate`/`act` (only `act` holds the
  // token).
  test('no other job in any of the 5 bot-token workflows references GSD_BOT_PR_TOKEN outside its documented job(s)', () => {
    const expected = {
      'auto-backmerge.yml': ['push'],
      'backmerge-merge-when-green.yml': ['act'],
      'ci-timeout-report.yml': ['report'],
      'release.yml': ['rc', 'finalize'],
      'dependabot-vendor-refresh.yml': ['refresh-vendor'],
    };
    for (const [file, allowedJobIds] of Object.entries(expected)) {
      const wf = loadWorkflow(file);
      const users = jobsUsingBotToken(wf).map(([id]) => id).sort();
      assert.deepEqual(users, [...allowedJobIds].sort(), `${file}: unexpected set of jobs using GSD_BOT_PR_TOKEN`);
    }
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
      /pr merge\b[^\n]*--admin/,
      'the auto-merge step must admin-merge the merge-back PR (symmetric with auto-backmerge main→next). See #2515.'
    );
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
