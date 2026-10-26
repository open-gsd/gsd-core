'use strict';

// #5607 — trust boundary of the "Reviewed or maintainer" workflow.
//
// The workflow reads untrusted PR data (author, head sha, reviews) under
// `pull_request_target` / `pull_request_review`, which run with the BASE
// repository's workflow context. The properties below are what keeps a PR from
// supplying its own policy, its own maintainer list, or shell text:
//   - it checks out the BASE sha, never the PR head or the merge ref
//   - it persists no credentials into the checkout
//   - its token is read-only
//   - no `run:` script interpolates `${{ }}`: PR-controlled values reach shell
//     only through `env:`
//   - on `merge_group` it executes nothing

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const FILE = path.join(__dirname, '..', '.github', 'workflows', 'reviewed-or-maintainer.yml');
const doc = yaml.load(fs.readFileSync(FILE, 'utf8'));
const job = doc.jobs['reviewed-or-maintainer'];
const triggers = doc.on ?? doc[true];

describe('#5607: reviewed-or-maintainer workflow trust boundary', () => {
  test('is named for the status context it reports', () => {
    assert.equal(job.name, 'Reviewed or maintainer');
  });

  test('triggers on target, review and merge_group events only', () => {
    assert.deepEqual(Object.keys(triggers).sort(), ['merge_group', 'pull_request_review', 'pull_request_target']);
    assert.deepEqual(triggers.pull_request_review.types, ['submitted', 'dismissed']);
    assert.deepEqual(triggers.merge_group.types, ['checks_requested']);
  });

  test('never uses the plain pull_request trigger, whose workflow file the PR controls', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(triggers, 'pull_request'), false);
  });

  test('the token is read-only', () => {
    for (const [scope, level] of Object.entries(doc.permissions)) {
      assert.ok(['read', 'none'].includes(level), `${scope}: ${level} must not be a write scope`);
    }
    assert.equal(job.permissions, undefined, 'a job-level permissions block would replace the read-only default');
  });

  test('the job is skipped on merge_group', () => {
    assert.equal(job.if, "github.event_name != 'merge_group'");
  });

  test('checks out the base sha and persists no credentials', () => {
    const checkout = job.steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
    assert.ok(checkout, 'a checkout step must exist');
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
  });

  test('checkout actions are pinned to a full commit sha', () => {
    for (const step of job.steps.filter((s) => typeof s.uses === 'string')) {
      assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
    }
  });

  test('no run: script interpolates a ${{ }} expression', () => {
    for (const step of job.steps.filter((s) => typeof s.run === 'string')) {
      assert.equal(step.run.includes('${{'), false, `step "${step.name}" interpolates an expression into shell`);
    }
  });

  test('PR-controlled values reach the policy only through env', () => {
    const evaluate = job.steps.find((step) => step.name === 'Evaluate');
    assert.equal(evaluate.env.PR_AUTHOR_LOGIN, '${{ github.event.pull_request.user.login }}');
    // The head sha is read live in the collect step, not replayed from the event.
    assert.equal(evaluate.env.HEAD_SHA, '${{ steps.collect.outputs.head_sha }}');
  });

  test('reviewer bots are never looked up for a role', () => {
    const collect = job.steps.find((step) => step.name === 'Collect reviews and reviewer permissions');
    assert.equal(collect.run.includes('[bot]'), true, 'the login filter must exclude bot logins explicitly');
    assert.equal(collect.run.includes('(\\[bot\\])?$'), false, 'the login filter must not admit a [bot] suffix');
  });

  test('a failed role lookup is reported, not silently turned into no approval', () => {
    const collect = job.steps.find((step) => step.name === 'Collect reviews and reviewer permissions');
    assert.equal(collect.run.includes('::warning::'), true);
  });

  test('runs the policy script from the checked-out base, not a PR path', () => {
    const evaluate = job.steps.find((step) => step.name === 'Evaluate');
    assert.equal(evaluate.run, 'node scripts/reviewed-or-maintainer-policy.cjs');
  });

  test('queue runs do not share one concurrency group, and event types do not cancel each other', () => {
    assert.match(doc.concurrency.group, /github\.event\.pull_request\.number \|\| github\.ref/);
    assert.match(doc.concurrency.group, /github\.event_name/);
  });

  test('is not yet a required status check on any committed ruleset', () => {
    const dir = path.join(__dirname, '..', '.github', 'rulesets');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const rule of spec.rules) {
        const contexts = rule.type === 'required_status_checks'
          ? rule.parameters.required_status_checks.map((c) => c.context)
          : [];
        assert.equal(contexts.includes('Reviewed or maintainer'), false, `${file} requires it before the trial`);
      }
    }
  });
});
