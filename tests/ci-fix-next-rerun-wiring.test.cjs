'use strict';

// #6076 — only `fix-next` label changes re-evaluate "Base branch health".
//
// Tests (test.yml) no longer triggers on label events. fix-next-rerun.yml
// re-runs only the `Base branch health` job when `fix-next` is added or
// removed, and the script reads the PR's current labels from the API.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  BASE_HEALTH_JOB_NAME, TESTS_WORKFLOW_FILE, DEFAULT_DEADLINE_MS, DEFAULT_POLL_MS, GH_TIMEOUT_MS,
} = require('../scripts/ci-fix-next-rerun.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

function load(file) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
}

/** js-yaml may parse the bare key `on` as the string "on" or as boolean true. */
function triggersOf(doc) {
  return doc.on ?? doc[true] ?? {};
}

describe('#6076 workflow wiring', () => {
  test('test.yml: pull_request uses default types and still targets next/main', () => {
    const pr = triggersOf(load('test.yml')).pull_request;
    assert.ok(pr && typeof pr === 'object', 'pull_request trigger must be a mapping');
    assert.ok(!('types' in pr), 'pull_request must not set types (label events must not start a run)');
    assert.deepEqual(pr.branches, ['next', 'main']);
  });

  test('test.yml: next-health passes PR_NUMBER to the script', () => {
    const job = load('test.yml').jobs['next-health'];
    const step = job.steps.find((s) => s.name === 'Check base branch health');
    assert.ok(step, 'Check base branch health step must exist');
    assert.equal(step.env.PR_NUMBER, '${{ github.event.pull_request.number }}');
  });

  test('parity: the script targets test.yml and the next-health job name', () => {
    assert.equal(BASE_HEALTH_JOB_NAME, load('test.yml').jobs['next-health'].name);
    assert.equal(TESTS_WORKFLOW_FILE, 'test.yml');
    assert.ok(fs.existsSync(path.join(WORKFLOWS_DIR, TESTS_WORKFLOW_FILE)));
  });

  describe('fix-next-rerun.yml', () => {
    const doc = load('fix-next-rerun.yml');
    const jobs = Object.values(doc.jobs);
    const job = jobs[0];

    test('triggers only on pull_request_target labeled/unlabeled', () => {
      const triggers = triggersOf(doc);
      assert.deepEqual(Object.keys(triggers), ['pull_request_target']);
      assert.deepEqual([...triggers.pull_request_target.types].sort(), ['labeled', 'unlabeled']);
    });

    test('top-level permissions are empty', () => {
      assert.deepEqual(doc.permissions ?? {}, {});
    });

    test('has exactly one job gated on the fix-next label', () => {
      assert.equal(jobs.length, 1);
      assert.equal(job.if, "github.event.label.name == 'fix-next'");
    });

    test('job permissions are exactly actions: write + contents: read + pull-requests: read', () => {
      assert.deepEqual(job.permissions, { actions: 'write', contents: 'read', 'pull-requests': 'read' });
    });

    test('job timeout covers the deadline, one more poll sleep and five gh calls', () => {
      assert.ok(DEFAULT_DEADLINE_MS + DEFAULT_POLL_MS + 5 * GH_TIMEOUT_MS < job['timeout-minutes'] * 60000);
    });

    test('the only checkout is the base sha, sparse, without persisted credentials', () => {
      const checkouts = job.steps.filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout'));
      assert.equal(checkouts.length, 1);
      assert.equal(checkouts[0].with.ref, '${{ github.event.pull_request.base.sha }}');
      assert.equal(checkouts[0].with['persist-credentials'], false);
      assert.equal(checkouts[0].with['sparse-checkout'], 'scripts');
    });

    test('no run block interpolates an expression', () => {
      for (const step of job.steps) {
        if (typeof step.run === 'string') assert.ok(!step.run.includes('${{'), step.name);
      }
    });

    test('the run step invokes the script with its inputs from env', () => {
      const step = job.steps.find((s) => typeof s.run === 'string');
      assert.ok(step.run.split('\n').some((l) => l.trim() === 'node scripts/ci-fix-next-rerun.cjs'));
      assert.equal(step.env.PR_NUMBER, '${{ github.event.pull_request.number }}');
      assert.equal(step.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
      assert.equal(step.env.GH_REPO, '${{ github.repository }}');
    });

    test('concurrency is at job level, per PR, cancelling in progress; none at workflow level', () => {
      assert.ok(!('concurrency' in doc), 'workflow-level concurrency would cancel on skipped label events');
      assert.ok(String(job.concurrency.group).includes('github.event.pull_request.number'));
      assert.equal(job.concurrency['cancel-in-progress'], true);
    });

    test('job has a bounded timeout', () => {
      assert.equal(typeof job['timeout-minutes'], 'number');
      assert.ok(job['timeout-minutes'] <= 120);
    });
  });
});
