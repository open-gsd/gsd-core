'use strict';

// install-smoke.yml structural wiring: the workflow_call trigger stays (the release.yml integration), the lifecycle
// smoke step runs scripts/release-tarball-smoke.cjs with --json and checks its result through jq, the pull_request path
// filter lists the smoke script and its install test, and an actions/upload-artifact step exists for failure debugging.
// Was tests/release-tarball-smoke-workflow.test.cjs, which read the structure with a line extractor for this file's
// indentation; this reads the parsed workflow.

const WORKFLOW = '.github/workflows/install-smoke.yml';
const SMOKE_SCRIPT = 'release-tarball-smoke.cjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The parsed workflow, or the reason it cannot be read.
function parse(text) {
  let workflow;
  try {
    workflow = require('js-yaml').load(text);
  } catch (err) {
    return { error: `install-smoke.yml is not valid YAML: ${err.message}` };
  }
  if (!isObject(workflow)) return { error: 'install-smoke.yml is not a mapping' };
  return isObject(workflow.jobs) ? { workflow } : { error: 'install-smoke.yml has no jobs mapping' };
}

function triggers(workflow) {
  const on = workflow.on;
  if (isObject(on)) return Object.keys(on);
  if (Array.isArray(on)) return on.map(String);
  return typeof on === 'string' ? [on] : [];
}

function pullRequestPaths(workflow) {
  const pullRequest = isObject(workflow.on) ? workflow.on.pull_request : undefined;
  return isObject(pullRequest) && Array.isArray(pullRequest.paths) ? pullRequest.paths.map(String) : [];
}

// Every step of every job, in document order.
function steps(workflow) {
  const jobs = isObject(workflow.jobs) ? Object.values(workflow.jobs) : [];
  return jobs.filter(isObject).flatMap((job) => (Array.isArray(job.steps) ? job.steps.filter(isObject) : []));
}

const smokeStepOf = (workflow) => steps(workflow).find((step) => typeof step.run === 'string' && step.run.includes(SMOKE_SCRIPT));

module.exports = {
  id: 'release-tarball-smoke-workflow',
  check(ctx) {
    const doc = ctx.doc(WORKFLOW);
    // A workflow that cannot be read is one finding; the structural checks below need the parsed workflow.
    let loaded = null;
    doc.satisfies((text) => {
      const parsed = parse(text);
      if (parsed.error) return parsed.error;
      loaded = parsed.workflow;
      return true;
    }, 'install-smoke.yml must be a workflow with a jobs mapping');
    if (loaded === null) return;
    const onWorkflow = (check) => () => check(loaded);
    doc
      .satisfies(onWorkflow((workflow) => triggers(workflow).includes('workflow_call') || `found ${JSON.stringify(triggers(workflow))}`), "install-smoke.yml must keep the workflow_call trigger (the release.yml integration)")
      .satisfies(onWorkflow((workflow) => smokeStepOf(workflow) !== undefined || 'no step'), 'the lifecycle smoke step must call release-tarball-smoke.cjs')
      .satisfies(onWorkflow((workflow) => {
        const step = smokeStepOf(workflow);
        return step === undefined || step.run.includes('--json') || 'no --json';
      }), 'the lifecycle smoke step must invoke the script with the --json flag')
      .satisfies(onWorkflow((workflow) => {
        const step = smokeStepOf(workflow);
        return step === undefined || step.run.includes('jq') || 'no jq';
      }), 'the lifecycle smoke result must be checked via jq')
      .satisfies(onWorkflow((workflow) => pullRequestPaths(workflow).includes('scripts/release-tarball-smoke.cjs') || `found ${JSON.stringify(pullRequestPaths(workflow))}`), 'the pull_request path filter must include scripts/release-tarball-smoke.cjs')
      .satisfies(onWorkflow((workflow) => pullRequestPaths(workflow).includes('tests/release-tarball-smoke.install.test.cjs') || `found ${JSON.stringify(pullRequestPaths(workflow))}`), 'the pull_request path filter must include tests/release-tarball-smoke.install.test.cjs')
      .satisfies(onWorkflow((workflow) => steps(workflow).some((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact')) || 'no such step'), 'an actions/upload-artifact step must exist for lifecycle smoke failure debugging');
  },
};
