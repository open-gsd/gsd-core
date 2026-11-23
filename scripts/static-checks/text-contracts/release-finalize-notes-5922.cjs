'use strict';

// release.yml's finalize job publishes the CHANGELOG section as the GitHub Release body, not `--generate-notes`
// (#5922): the "Create GitHub Release" step is no longer fed by it, the "Build GitHub Release notes" step runs
// before the irreversible tag and publish steps, unconditionally, and its notes file is the one the create step
// consumes; the rc job (X.Y.0 only, hotfix rcs are rejected) keeps GitHub-generated notes. Executing the step bodies
// against a fake `gh` stays in release-notes-real-os-5922.test.cjs. Was tests/release-finalize-notes-5922.test.cjs.

const CREATE_STEP = 'Create GitHub Release';
const BUILD_STEP = 'Build GitHub Release notes';
const NOTES_PATH = '${RUNNER_TEMP}/release-notes.md';

const stepsOf = (text, jobName) => {
  const workflow = require('js-yaml').load(text);
  return (workflow.jobs && workflow.jobs[jobName] && workflow.jobs[jobName].steps) || [];
};
const stepNamed = (text, jobName, name) => stepsOf(text, jobName).find((step) => step.name === name);
const indexOfStep = (steps, name) => steps.findIndex((step) => step.name === name);

module.exports = {
  id: 'release-finalize-notes-5922',
  issue: '#5922',
  check(ctx) {
    ctx.doc('.github/workflows/release.yml')
      .satisfies((text) => {
        const create = stepNamed(text, 'finalize', CREATE_STEP);
        return (create !== undefined && typeof create.run === 'string') || 'no step, or no run script';
      }, 'finalize must have a "Create GitHub Release" step with a run script')
      .satisfies((text) => {
        const create = stepNamed(text, 'finalize', CREATE_STEP);
        return !create || typeof create.run !== 'string' || !create.run.includes('--generate-notes');
      }, 'the create step must no longer be fed by --generate-notes')
      .satisfies((text) => {
        const create = stepNamed(text, 'finalize', CREATE_STEP);
        return !create || typeof create.run !== 'string' || !create.run.includes('format-github-release-notes');
      }, 'the create step must not call format-github-release-notes')
      .satisfies((text) => indexOfStep(stepsOf(text, 'finalize'), BUILD_STEP) > -1, 'finalize must have a "Build GitHub Release notes" step')
      .satisfies((text) => {
        const steps = stepsOf(text, 'finalize');
        return indexOfStep(steps, BUILD_STEP) < indexOfStep(steps, 'Tag and push');
      }, 'the notes must be built before Tag and push')
      .satisfies((text) => {
        const steps = stepsOf(text, 'finalize');
        return indexOfStep(steps, BUILD_STEP) < indexOfStep(steps, 'Publish to npm (latest)');
      }, 'the notes must be built before the npm publish')
      .satisfies((text) => {
        const steps = stepsOf(text, 'finalize');
        return indexOfStep(steps, BUILD_STEP) > indexOfStep(steps, 'Verify CHANGELOG promoted');
      }, 'the notes must be built from the promoted CHANGELOG')
      .satisfies((text) => {
        const build = stepNamed(text, 'finalize', BUILD_STEP);
        return !build || build.if === undefined;
      }, 'the build step must have no dry_run guard: a dry run validates the builder too')
      .satisfies((text) => {
        const build = stepNamed(text, 'finalize', BUILD_STEP);
        return Boolean(build) && typeof build.run === 'string' && build.run.includes(NOTES_PATH);
      }, 'the build step must write the notes file the create step reads')
      .satisfies((text) => {
        const create = stepNamed(text, 'finalize', CREATE_STEP);
        return Boolean(create) && typeof create.run === 'string' && create.run.includes(`--notes-file "${NOTES_PATH}"`);
      }, 'the create step must consume the notes from the same path')
      .satisfies((text) => {
        const create = stepNamed(text, 'finalize', CREATE_STEP);
        return !create || typeof create.run !== 'string' || !create.run.includes('changelog-release-notes');
      }, 'the create step only publishes: it must not build the notes')
      .satisfies((text) => {
        const rc = stepNamed(text, 'rc', 'Create GitHub pre-release');
        return Boolean(rc) && typeof rc.run === 'string' && rc.run.includes('--generate-notes');
      }, 'the rc job (X.Y.0 only, hotfix rcs are rejected) must keep GitHub-generated notes in its "Create GitHub pre-release" step');
  },
};
