'use strict';

/**
 * Per-file durations artifact uploads must not fail the job (#6144).
 *
 * The `test-timings-*` artifact is diagnostic scheduling / timeout-evidence
 * data, not a test result. When the GitHub artifact service is unavailable
 * (it returned HTML on every retry in #6144), the upload step failed a job
 * whose tests had all passed. Those uploads are `continue-on-error: true`;
 * the compacted-coverage upload is a gate input and stays fatal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');

function uploadSteps(namePrefix) {
  const wf = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
  const found = [];
  for (const job of Object.values(wf.jobs || {})) {
    for (const step of job.steps || []) {
      const uses = typeof step.uses === 'string' ? step.uses : '';
      const name = step.with && typeof step.with.name === 'string' ? step.with.name : '';
      if (uses.startsWith('actions/upload-artifact') && name.startsWith(namePrefix)) {
        found.push(step);
      }
    }
  }
  return found;
}

test('exactly two test-timings upload steps exist', () => {
  assert.equal(uploadSteps('test-timings-').length, 2);
});

test('every test-timings upload step is continue-on-error: true', () => {
  for (const step of uploadSteps('test-timings-')) {
    assert.equal(step['continue-on-error'], true, `step "${step.name}" must be non-fatal`);
  }
});

test('the compacted-coverage upload stays fatal', () => {
  const steps = uploadSteps('coverage-tmp-shard-');
  assert.ok(steps.length >= 1, 'coverage upload step must exist');
  for (const step of steps) {
    assert.notEqual(step['continue-on-error'], true, `step "${step.name}" must stay fatal`);
  }
});
