'use strict';

/**
 * #5922: release.yml's finalize job must publish the CHANGELOG section as the
 * GitHub Release body, not `--generate-notes` (empty for a hotfix of
 * cherry-picks). Workflow structure is asserted here; executing the step bodies
 * against a fake `gh` lives in release-notes-real-os-5922.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..');
const CREATE_STEP = 'Create GitHub Release';
const BUILD_STEP = 'Build GitHub Release notes';
const NOTES_PATH = '${RUNNER_TEMP}/release-notes.md';

function loadSteps(jobName) {
  const wf = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8'));
  return (wf.jobs[jobName] && wf.jobs[jobName].steps) || [];
}

function loadStep(jobName, stepName) {
  return loadSteps(jobName).find((s) => s.name === stepName);
}

const indexOfStep = (steps, name) => steps.findIndex((s) => s.name === name);

describe('release.yml finalize "Create GitHub Release" (#5922)', () => {
  const finalizeStep = loadStep('finalize', CREATE_STEP);
  const buildStep = loadStep('finalize', BUILD_STEP);

  test('the step exists and is no longer fed by --generate-notes', () => {
    assert.ok(finalizeStep, 'finalize must have a "Create GitHub Release" step');
    assert.equal(typeof finalizeStep.run, 'string');
    assert.equal(finalizeStep.run.includes('--generate-notes'), false);
    assert.equal(finalizeStep.run.includes('format-github-release-notes'), false);
  });

  test('the notes are built before the irreversible tag/publish steps, unconditionally, and consumed from the same path', () => {
    const steps = loadSteps('finalize');
    const build = indexOfStep(steps, BUILD_STEP);
    assert.ok(build > -1, 'finalize must have a "Build GitHub Release notes" step');
    assert.ok(build < indexOfStep(steps, 'Tag and push'), 'built before Tag and push');
    assert.ok(build < indexOfStep(steps, 'Publish to npm (latest)'), 'built before npm publish');
    assert.ok(build > indexOfStep(steps, 'Verify CHANGELOG promoted'), 'built from the promoted CHANGELOG');
    assert.equal(buildStep.if, undefined, 'no dry_run guard: a dry run validates the builder too');
    assert.ok(buildStep.run.includes(NOTES_PATH));
    assert.ok(finalizeStep.run.includes(`--notes-file "${NOTES_PATH}"`));
    assert.equal(finalizeStep.run.includes('changelog-release-notes'), false, 'create step only publishes');
  });

  // release.yml:72 rejects an rc for hotfix versions ("Hotfix (patch) releases
  // skip the rc action"), so rc only runs for X.Y.0 cut from next, whose
  // commits are the original PR merge commits: GitHub's generated list is
  // correct there and the pre-release keeps it.
  test('the rc job (X.Y.0 only, hotfix rcs are rejected) keeps GitHub-generated notes', () => {
    const rcStep = loadStep('rc', 'Create GitHub pre-release');
    assert.ok(rcStep, 'rc job has a "Create GitHub pre-release" step');
    assert.ok(rcStep.run.includes('--generate-notes'));
  });
});
