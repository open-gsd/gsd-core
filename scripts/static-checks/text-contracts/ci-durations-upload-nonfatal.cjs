'use strict';

// The per-file durations artifact uploads of test.yml must not fail the job (#6144): the `test-timings-*` artifact
// is diagnostic scheduling data, not a test result, so when the artifact service is unavailable the upload step
// must not fail a job whose tests passed. Both such uploads are `continue-on-error: true`; the compacted-coverage
// upload is a gate input and stays fatal. Was tests/ci-durations-upload-nonfatal.test.cjs.

// The `actions/upload-artifact` steps whose artifact name starts with `namePrefix`, across every job.
function uploadSteps(text, namePrefix) {
  const workflow = require('js-yaml').load(text);
  const found = [];
  for (const job of Object.values((workflow && workflow.jobs) || {})) {
    for (const step of job.steps || []) {
      const uses = typeof step.uses === 'string' ? step.uses : '';
      const name = step.with && typeof step.with.name === 'string' ? step.with.name : '';
      if (uses.startsWith('actions/upload-artifact') && name.startsWith(namePrefix)) found.push(step);
    }
  }
  return found;
}

module.exports = {
  id: 'ci-durations-upload-nonfatal',
  issue: '#6144',
  check(ctx) {
    ctx.doc('.github/workflows/test.yml')
      .satisfies((text) => {
        const count = uploadSteps(text, 'test-timings-').length;
        return count === 2 || `found ${count}`;
      }, 'exactly two test-timings upload steps must exist')
      .satisfies((text) => {
        const fatal = uploadSteps(text, 'test-timings-').filter((step) => step['continue-on-error'] !== true);
        return fatal.length === 0 || fatal.map((step) => `step "${step.name}"`).join(', ');
      }, 'every test-timings upload step must be continue-on-error: true (non-fatal)')
      .satisfies((text) => {
        const steps = uploadSteps(text, 'coverage-tmp-shard-');
        if (steps.length < 1) return 'no coverage upload step found';
        const lenient = steps.filter((step) => step['continue-on-error'] === true);
        return lenient.length === 0 || lenient.map((step) => `step "${step.name}"`).join(', ');
      }, 'the compacted-coverage upload must stay fatal');
  },
};
