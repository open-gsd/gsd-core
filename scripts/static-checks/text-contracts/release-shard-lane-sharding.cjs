'use strict';

// release.yml's rc and finalize jobs shard the unit suite the way test.yml's full lane does (#4335, recurrence of
// #2280/#2281): each *-test job's matrix declares a complete shard set, passes its slice to run-tests, uploads a
// distinctly named raw coverage artifact; a dedicated coverage-gate job needs it, merges every shard and runs the
// report; and the final job needs its gate. Was the workflow half of tests/release-shard-lane-sharding.test.cjs (the
// boundary cases of the shard-spec helper stay there: their subject is that helper's code).

const WORKFLOW = '.github/workflows/release.yml';
const LANES = [
  { label: 'rc', testJob: 'rc-test', gateJob: 'rc-coverage-gate', finalJob: 'rc', artifactPrefix: 'coverage-tmp-rc-shard-' },
  { label: 'finalize', testJob: 'finalize-test', gateJob: 'finalize-coverage-gate', finalJob: 'finalize', artifactPrefix: 'coverage-tmp-finalize-shard-' },
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps.filter(isObject) : []);
const dependsOn = (job, name) => (Array.isArray(job.needs) ? job.needs.includes(name) : job.needs === name);

// The jobs mapping of release.yml, or the reason it cannot be read.
function withJobs(check) {
  return (text) => {
    let workflow;
    try {
      workflow = require('js-yaml').load(text);
    } catch (err) {
      return `release.yml is not valid YAML: ${err.message}`;
    }
    if (!isObject(workflow) || !isObject(workflow.jobs)) return 'release.yml has no jobs mapping';
    return check(workflow.jobs);
  };
}

module.exports = {
  id: 'release-shard-lane-sharding',
  issue: '#4335',
  check(ctx) {
    const { isCompleteShardSet } = require('../../../tests/helpers/shard-spec.cjs');
    const workflow = ctx.doc(WORKFLOW);
    for (const lane of LANES) {
      workflow
        .satisfies(withJobs((jobs) => {
          const job = jobs[lane.testJob];
          if (!isObject(job)) return `release.yml declares no ${lane.testJob} job`;
          const shards = (isObject(job.strategy) && isObject(job.strategy.matrix) && job.strategy.matrix.shard) || [];
          if (!(Array.isArray(shards) && shards.length > 1)) return `${lane.testJob} is not actually sharded (matrix.shard: ${JSON.stringify(shards)})`;
          return isCompleteShardSet(shards) || `the declared shards ${JSON.stringify(shards)} are not a complete set (one denominator, numerators exactly 1..N)`;
        }), `${lane.label}: the ${lane.testJob} matrix must declare a complete shard set: a missing numerator silently stops running that slice of the suite`)
        .satisfies(withJobs((jobs) => {
          const job = jobs[lane.testJob];
          if (!isObject(job)) return `release.yml declares no ${lane.testJob} job`;
          const unitStep = stepsOf(job).find((step) => typeof step.run === 'string' && step.run.includes('test:coverage:unit:raw'));
          if (!unitStep) return `no step in ${lane.testJob} runs the raw unit coverage script`;
          return unitStep.run.includes('--shard ${{ matrix.shard }}') || 'the unit step does not pass matrix.shard through to run-tests';
        }), `${lane.label}: each shard must run its own slice, not the whole suite`)
        .satisfies(withJobs((jobs) => {
          const job = jobs[lane.testJob];
          if (!isObject(job)) return `release.yml declares no ${lane.testJob} job`;
          const upload = stepsOf(job).find((step) => String(step.uses || '').includes('upload-artifact'));
          if (!upload) return `no upload-artifact step in ${lane.testJob}`;
          const name = String(isObject(upload.with) ? upload.with.name : undefined);
          return name.startsWith(lane.artifactPrefix) || `the upload-artifact name ${JSON.stringify(name)} does not start with ${lane.artifactPrefix}`;
        }), `${lane.label}: each shard must upload a distinctly named raw coverage artifact`)
        .satisfies(withJobs((jobs) => {
          const gate = jobs[lane.gateJob];
          if (!isObject(gate)) return `release.yml declares no ${lane.gateJob} job`;
          if (!dependsOn(gate, lane.testJob)) return `${lane.gateJob} does not depend on ${lane.testJob}`;
          const merges = stepsOf(gate).some((step) => String(step.uses || '').includes('download-artifact')
            && isObject(step.with) && step.with['merge-multiple'] === true
            && String(step.with.pattern || '').startsWith(lane.artifactPrefix));
          if (!merges) return `${lane.gateJob} does not download the ${lane.artifactPrefix}* shard artifacts with merge-multiple`;
          return stepsOf(gate).some((step) => typeof step.run === 'string' && step.run.includes('test:coverage:report')) || `${lane.gateJob} never runs the coverage report and gate script`;
        }), `${lane.label}: a dedicated coverage-gate job must exist, depend on the test job and merge every shard`)
        .satisfies(withJobs((jobs) => {
          const finalJob = jobs[lane.finalJob];
          if (!isObject(finalJob)) return `release.yml declares no ${lane.finalJob} job`;
          return dependsOn(finalJob, lane.gateJob) || `${lane.finalJob} does not depend on ${lane.gateJob}`;
        }), `${lane.label}: the final job must depend on its coverage gate, or a red or skipped gate could not block tagging and publishing`);
    }
  },
};
