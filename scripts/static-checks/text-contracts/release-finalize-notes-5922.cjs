'use strict';

// release.yml's finalize job publishes the CHANGELOG section as the GitHub Release body, not `--generate-notes`
// (#5922): the "Create GitHub Release" step is no longer fed by it, the "Build GitHub Release notes" step runs
// after the CHANGELOG is promoted and before the irreversible tag and publish steps, unconditionally, and its notes
// file is the one the create step consumes; the rc job (X.Y.0 only, hotfix rcs are rejected) keeps GitHub-generated
// notes. Executing the step bodies against a fake `gh` stays in release-notes-real-os-5922.test.cjs. A workflow that
// does not parse is one finding (the first assertion), not an exception that hides the rest. Was
// tests/release-finalize-notes-5922.test.cjs.

const CREATE_STEP = 'Create GitHub Release';
const BUILD_STEP = 'Build GitHub Release notes';
const VERIFY_STEP = 'Verify CHANGELOG promoted';
const NOTES_PATH = '${RUNNER_TEMP}/release-notes.md';

const loadWorkflow = (text) => {
  try {
    return { workflow: require('js-yaml').load(text) };
  } catch (err) {
    return { error: `release.yml is not valid YAML: ${String(err.message).split('\n')[0]}` };
  }
};
// Runs `check(workflow)`; a workflow that did not parse was already reported by the first assertion, so the rest pass.
const onWorkflow = (check) => (text) => {
  const parsed = loadWorkflow(text);
  return parsed.error ? true : check(parsed.workflow);
};
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const jobOf = (workflow, jobName) => (isMapping(workflow) && isMapping(workflow.jobs) && isMapping(workflow.jobs[jobName]) ? workflow.jobs[jobName] : undefined);
// The mapping steps of a job, in order; a malformed `steps` or entry is reported by the structure assertion, not thrown on here.
const stepsOf = (workflow, jobName) => {
  const job = jobOf(workflow, jobName);
  return job && Array.isArray(job.steps) ? job.steps.filter(isMapping) : [];
};
const stepNamed = (workflow, jobName, name) => stepsOf(workflow, jobName).find((step) => step.name === name);
const indexOfStep = (steps, name) => steps.findIndex((step) => step.name === name);
// The first malformed spot of the two jobs this contract reads, or true.
const structureOf = (workflow) => {
  if (!isMapping(workflow)) return 'release.yml is not a mapping';
  if (workflow.jobs !== undefined && !isMapping(workflow.jobs)) return 'jobs is not a mapping';
  for (const jobName of ['finalize', 'rc']) {
    const job = isMapping(workflow.jobs) ? workflow.jobs[jobName] : undefined;
    if (job === undefined) continue; // a missing job is reported by the assertions that read its steps
    if (!isMapping(job)) return `${jobName} is not a mapping`;
    if (!Array.isArray(job.steps)) return `${jobName}.steps is not a list`;
    const bad = job.steps.findIndex((step) => !isMapping(step));
    if (bad > -1) return `${jobName}.steps[${bad}] is not a mapping`;
  }
  return true;
};
const runOf = (workflow, jobName, name) => {
  const step = stepNamed(workflow, jobName, name);
  return step && typeof step.run === 'string' ? step.run : undefined;
};

module.exports = {
  id: 'release-finalize-notes-5922',
  issue: '#5922',
  check(ctx) {
    ctx.doc('.github/workflows/release.yml')
      .satisfies((text) => loadWorkflow(text).error || true, 'release.yml must be valid YAML')
      .satisfies(onWorkflow(structureOf), 'the finalize and rc jobs of release.yml must be mappings with a list of mapping steps')
      .satisfies(onWorkflow((workflow) => runOf(workflow, 'finalize', CREATE_STEP) !== undefined), 'finalize must have a "Create GitHub Release" step with a run script')
      .satisfies(onWorkflow((workflow) => {
        const run = runOf(workflow, 'finalize', CREATE_STEP);
        return run === undefined || !run.includes('--generate-notes');
      }), 'the create step must no longer be fed by --generate-notes')
      .satisfies(onWorkflow((workflow) => {
        const run = runOf(workflow, 'finalize', CREATE_STEP);
        return run === undefined || !run.includes('format-github-release-notes');
      }), 'the create step must not call format-github-release-notes')
      .satisfies(onWorkflow((workflow) => indexOfStep(stepsOf(workflow, 'finalize'), BUILD_STEP) > -1), 'finalize must have a "Build GitHub Release notes" step')
      .satisfies(onWorkflow((workflow) => {
        const steps = stepsOf(workflow, 'finalize');
        return indexOfStep(steps, BUILD_STEP) < indexOfStep(steps, 'Tag and push');
      }), 'the notes must be built before Tag and push')
      .satisfies(onWorkflow((workflow) => {
        const steps = stepsOf(workflow, 'finalize');
        return indexOfStep(steps, BUILD_STEP) < indexOfStep(steps, 'Publish to npm (latest)');
      }), 'the notes must be built before the npm publish')
      .satisfies(onWorkflow((workflow) => {
        const steps = stepsOf(workflow, 'finalize');
        const verify = indexOfStep(steps, VERIFY_STEP);
        return verify > -1 && indexOfStep(steps, BUILD_STEP) > verify;
      }), 'the notes must be built from the promoted CHANGELOG, after the "Verify CHANGELOG promoted" step')
      .satisfies(onWorkflow((workflow) => {
        const build = stepNamed(workflow, 'finalize', BUILD_STEP);
        return !build || build.if === undefined;
      }), 'the build step must have no dry_run guard: a dry run validates the builder too')
      .satisfies(onWorkflow((workflow) => {
        const run = runOf(workflow, 'finalize', BUILD_STEP);
        return run !== undefined && run.includes(NOTES_PATH);
      }), 'the build step must write the notes file the create step reads')
      .satisfies(onWorkflow((workflow) => {
        const run = runOf(workflow, 'finalize', CREATE_STEP);
        return run !== undefined && run.includes(`--notes-file "${NOTES_PATH}"`);
      }), 'the create step must consume the notes from the same path')
      .satisfies(onWorkflow((workflow) => {
        const run = runOf(workflow, 'finalize', CREATE_STEP);
        return run === undefined || !run.includes('changelog-release-notes');
      }), 'the create step only publishes: it must not build the notes')
      .satisfies(onWorkflow((workflow) => {
        const run = runOf(workflow, 'rc', 'Create GitHub pre-release');
        return run !== undefined && run.includes('--generate-notes');
      }), 'the rc job (X.Y.0 only, hotfix rcs are rejected) must keep GitHub-generated notes in its "Create GitHub pre-release" step');
  },
};
