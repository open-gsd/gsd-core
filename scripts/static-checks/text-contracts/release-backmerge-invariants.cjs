'use strict';

// The release-critical workflow invariants of the auto-backmerge fix (#2504, #2515, #5894), read from the parsed YAML of
// auto-backmerge.yml and release.yml (the copies diverge between main and next, so a fix applied to one regresses in the
// other): the version-sync and its build:lib prerequisite are non-fatal and ordered, the ancestry steps are never gated on a
// step outcome, the back-merge lands through merge-commit-pr.cjs (never gh pr merge) with HAS_ADMIN_TOKEN read from the
// secret, a `merge -s ours` reconcile step exists; finalize keeps a job cap of at least the rc budget, auto-merges the
// release PR only when MERGEABLE, non-fatally and after Verify publish; validate-version requires main to be an ancestor of
// next after the published-version check, gated on non-rc non-hotfix runs, and every other job needs it. A missing step or
// job is one finding that skips the checks which depend on it. The two guards that run the step's shell stay in
// tests/release-backmerge-invariants.test.cjs. Was the YAML half of that test.

const { hasSequence } = require('./lib/has-sequence.cjs');
const { loadLib } = require('./lib/load-lib.cjs');

const BACKMERGE = '.github/workflows/auto-backmerge.yml';
const RELEASE = '.github/workflows/release.yml';
const HAS_ADMIN_TOKEN_EXPR = "${{ secrets.GSD_BOT_PR_TOKEN != '' }}";
const FINALIZE_JOB_CAP_FLOOR = 30;
const MERGE_STEP = 'Merge the back-merge PR as a merge commit';
const AUTO_MERGE_STEP = 'Auto-merge the release';
const ANCESTRY_STEP = 'Require main to be an ancestor of next';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);

// The parsed workflow, or the reason it cannot be read.
function parse(text, label, yaml) {
  let workflow;
  try {
    workflow = yaml.load(text);
  } catch (err) {
    return { error: `${label} is not valid YAML: ${err.message}` };
  }
  return isObject(workflow) && isObject(workflow.jobs) ? { workflow } : { error: `${label} is not a workflow with a jobs mapping` };
}

const indexOfNamed = (steps, part) => steps.findIndex((step) => isObject(step) && typeof step.name === 'string' && step.name.includes(part));
const runOf = (step) => (isObject(step) && typeof step.run === 'string' ? step.run : '');

// `.outcome` or `.conclusion` followed by a non-word character: a gate on another step's result.
function gatesOnOutcome(condition) {
  return ['.outcome', '.conclusion'].some((marker) => {
    let at = condition.indexOf(marker);
    while (at !== -1) {
      if (!isWordChar(condition[at + marker.length])) return true;
      at = condition.indexOf(marker, at + 1);
    }
    return false;
  });
}

// One workflow document with its parsed form; a workflow that cannot be read is one finding and `check` is not run.
function withWorkflow(ctx, rel, label, yaml, check) {
  const doc = ctx.doc(rel);
  let loaded = null;
  doc.satisfies((text) => {
    const parsed = parse(text, label, yaml);
    if (parsed.error) return parsed.error;
    loaded = parsed.workflow;
    return true;
  }, `${label} must be a workflow with a jobs mapping`);
  if (loaded !== null) check(doc, loaded);
}

// Runs `fn` when `present` (the assertion's prerequisite exists); a missing prerequisite is already one finding.
const when = (present, fn) => () => (present ? fn() : true);

module.exports = {
  // The linear walkers, exported for the differential properties of tests/text-contracts.batch10.test.cjs.
  gatesOnOutcome, hasSequence, parse,
  id: 'release-backmerge-invariants',
  issue: '#2504',
  check(ctx, load = () => require('js-yaml')) {
    // The parser is loaded once: a module that cannot be loaded is one finding for both workflows, and neither is read.
    const loadedYaml = loadLib(load, 'js-yaml');
    if (loadedYaml.error) {
      ctx.fail('.github/workflows', loadedYaml.error);
      return;
    }
    const yaml = loadedYaml.lib;
    withWorkflow(ctx, BACKMERGE, 'auto-backmerge.yml', yaml, (doc, workflow) => {
      const job = workflow.jobs.backmerge;
      const steps = isObject(job) ? job.steps : undefined;
      doc.satisfies(() => Array.isArray(steps) || 'jobs.backmerge.steps is not an array', 'jobs.backmerge.steps must be an array');
      if (!Array.isArray(steps)) return;
      const syncAt = indexOfNamed(steps, "Sync next's version");
      const buildAt = steps.findIndex((step) => runOf(step).includes('npm run build:lib'));
      const openAt = indexOfNamed(steps, 'Open or update PR');
      const mergeAt = indexOfNamed(steps, MERGE_STEP);
      const merge = mergeAt === -1 ? undefined : steps[mergeAt];
      doc
        .satisfies(() => syncAt !== -1 || 'no such step', 'expected a step named like "Sync next\'s version"')
        .satisfies(when(syncAt !== -1, () => steps[syncAt]['continue-on-error'] === true || `continue-on-error is ${JSON.stringify(steps[syncAt]['continue-on-error'])}`),
          'version-sync must be continue-on-error so a sync failure never blocks the back-merge PR (the step that makes `main` an ancestor of `next`)')
        .satisfies(() => buildAt !== -1 || 'no such step', 'expected a step running `npm run build:lib` before the version sync')
        .satisfies(when(buildAt !== -1, () => steps[buildAt]['continue-on-error'] === true || `continue-on-error is ${JSON.stringify(steps[buildAt]['continue-on-error'])}`),
          'the build:lib step is only a prerequisite of the best-effort version-sync; it must be continue-on-error too so its failure cannot abort the ancestry PR')
        .satisfies(when(syncAt !== -1 && buildAt !== -1, () => buildAt < syncAt || `build:lib is step ${buildAt}, the sync is step ${syncAt}`),
          'the build:lib step must precede the version-sync step so the `version` lifecycle hook finds the built capability-ledger.cjs')
        .satisfies(() => openAt !== -1 || 'no such step', "expected an 'Open or update PR' step")
        .satisfies(() => mergeAt !== -1 || 'no such step', `expected a '${MERGE_STEP}' step`);
      for (const at of [openAt, mergeAt]) {
        if (at === -1) continue;
        const step = steps[at];
        const condition = typeof step.if === 'string' ? step.if : '';
        doc.satisfies(() => !gatesOnOutcome(condition) || `if: ${condition}`,
          `'${step.name}' must not gate on a step outcome/conclusion: that would let a version-sync failure block the ancestry PR again`);
      }
      doc
        .satisfies(when(merge !== undefined, () => runOf(merge).includes('node scripts/merge-commit-pr.cjs "$PR"') || 'the step does not run it'),
          'the back-merge must land through merge-commit-pr.cjs')
        .satisfies(when(merge !== undefined, () => !runOf(merge).includes('gh pr merge') || 'the step runs gh pr merge'),
          'the back-merge must never use `gh pr merge` (#5894)')
        .satisfies(when(merge !== undefined, () => (isObject(merge.env) && merge.env.HAS_ADMIN_TOKEN === HAS_ADMIN_TOKEN_EXPR) || `env is ${JSON.stringify(merge.env)}`),
          'the back-merge step must read HAS_ADMIN_TOKEN from the secret')
        .satisfies(() => steps.some((step) => hasSequence(runOf(step), ['merge', '-s', 'ours'])) || 'no such step',
          "expected a `git merge -s ours` reconcile step keeping next's tree wholesale");
    });

    withWorkflow(ctx, RELEASE, 'release.yml', yaml, (doc, workflow) => {
      const jobs = workflow.jobs;
      // A job that is missing or not a mapping, or whose steps are not a list, is one finding that skips every check
      // depending on it.
      const stepsOf = (name) => {
        const job = jobs[name];
        let problem = null;
        if (!isObject(job)) problem = 'no such job';
        else if (!Array.isArray(job.steps)) problem = 'steps is not a list';
        doc.satisfies(() => problem === null || problem, `expected a ${name} job in release.yml with a steps list`);
        return problem === null ? job.steps : null;
      };

      const finalizeSteps = stepsOf('finalize');
      if (finalizeSteps !== null) {
        const capped = jobs.finalize['timeout-minutes'];
        doc.satisfies(() => (typeof capped === 'number' && capped >= FINALIZE_JOB_CAP_FLOOR) || `finalize timeout-minutes is ${JSON.stringify(capped)}`,
          `the finalize job cap must be at least the rc budget (>= ${FINALIZE_JOB_CAP_FLOOR} minutes): a smaller budget cancels finalize mid-test before tag/publish`);
        const autoAt = indexOfNamed(finalizeSteps, AUTO_MERGE_STEP);
        const auto = autoAt === -1 ? undefined : finalizeSteps[autoAt];
        doc.satisfies(() => autoAt !== -1 || 'no such step', `expected a finalize step named like '${AUTO_MERGE_STEP} \u2192 main PR'`);
        if (auto !== undefined) {
          doc
            .satisfies(() => runOf(auto).includes('node scripts/merge-commit-pr.cjs "$PR"') || 'the step does not run it',
              'the auto-merge step must land the merge-back PR through merge-commit-pr.cjs (a verified merge commit, #5894)')
            .satisfies(() => !runOf(auto).includes('gh pr merge') || 'the step runs gh pr merge',
              'the auto-merge step must never use `gh pr merge`')
            .satisfies(() => (isObject(auto.env) && auto.env.HAS_ADMIN_TOKEN === HAS_ADMIN_TOKEN_EXPR) || `env is ${JSON.stringify(auto.env)}`,
              'the auto-merge step must read HAS_ADMIN_TOKEN from the secret')
            .satisfies(() => runOf(auto).includes('MERGEABLE') || 'the step does not mention MERGEABLE',
              'the auto-merge must gate on the PR being MERGEABLE so a genuine divergence is left open for manual resolution')
            .satisfies(() => auto['continue-on-error'] === true || `continue-on-error is ${JSON.stringify(auto['continue-on-error'])}`,
              'the merge-back auto-merge must be continue-on-error: the tag and npm publish already happened');
        }
        const verifyAt = indexOfNamed(finalizeSteps, 'Verify publish');
        doc.satisfies(() => verifyAt !== -1 || 'no such step', "expected a 'Verify publish' step");
        if (autoAt !== -1 && verifyAt !== -1) {
          doc.satisfies(() => autoAt > verifyAt || `the auto-merge is step ${autoAt}, Verify publish is step ${verifyAt}`,
            'the auto-merge must run after "Verify publish" so main never absorbs a release whose npm publish was not confirmed');
        }
      }

      const validateSteps = stepsOf('validate-version');
      if (validateSteps !== null) {
        const ancestryAt = indexOfNamed(validateSteps, ANCESTRY_STEP);
        const publishedAt = indexOfNamed(validateSteps, 'Reject already-published versions');
        const ancestry = ancestryAt === -1 ? undefined : validateSteps[ancestryAt];
        doc
          .satisfies(() => ancestryAt !== -1 || 'no such step', `expected a '${ANCESTRY_STEP}' step`)
          .satisfies(() => publishedAt !== -1 || 'no such step', "expected a 'Reject already-published versions' step");
        if (ancestryAt !== -1 && publishedAt !== -1) {
          doc.satisfies(() => ancestryAt > publishedAt || `the ancestry step is step ${ancestryAt}, the published check is step ${publishedAt}`,
            'validate-version must require main to be an ancestor of next after the published-version check');
        }
        if (ancestry !== undefined) {
          doc
            .satisfies(() => runOf(ancestry).includes('node scripts/release-ancestry.cjs --ancestor origin/main --descendant origin/next') || 'the step does not run it',
              'the ancestry step must run release-ancestry.cjs against origin/main and origin/next')
            .satisfies(() => ancestry.if === "inputs.action != 'rc' && steps.validate.outputs.is_hotfix != 'true'" || `if is ${JSON.stringify(ancestry.if)}`,
              'validate-version must gate the ancestry step on non-rc, non-hotfix runs');
        }
      }
      doc.satisfies(() => {
        for (const [name, job] of Object.entries(jobs)) {
          if (name === 'validate-version') continue;
          if (!isObject(job)) continue;
          const needs = [].concat(job.needs || []);
          if (!needs.includes('validate-version')) return `job ${name} must list validate-version in needs`;
        }
        return true;
      }, 'every other job needs validate-version, so the ancestry gate runs before any tagging job');
    });
  },
};
