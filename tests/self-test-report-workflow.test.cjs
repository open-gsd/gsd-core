'use strict';

// #5612 — trust boundary of the "Self-test report" workflow.
//
// It reads untrusted PR data (title, body, head ref, author) under
// `pull_request_target`. The properties below keep a PR from supplying its own
// policy, its own maintainer list, or shell text:
//   - it checks out the BASE sha, never the PR head or the merge ref
//   - it persists no credentials into the checkout
//   - its token is read-only
//   - no `run:` script interpolates `${{ }}`: PR-controlled values reach shell
//     only through `env:`
//   - on `merge_group` it executes nothing
// It also pins the advisory contract: it is not a required status check yet, and
// the PR template carries the section the policy looks for.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const doc = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'self-test-report.yml'), 'utf8'));
const job = doc.jobs['self-test-report'];
const triggers = doc.on ?? doc[true];

describe('#5612: self-test-report workflow trust boundary', () => {
  test('is named for the status context it reports', () => {
    assert.equal(job.name, 'Self-test report');
  });

  test('triggers on pull_request_target and merge_group only, never the plain pull_request', () => {
    assert.deepEqual(Object.keys(triggers).sort(), ['merge_group', 'pull_request_target']);
    assert.deepEqual(triggers.merge_group.types, ['checks_requested']);
    assert.ok(triggers.pull_request_target.types.includes('edited'), 'editing the body must re-evaluate');
    assert.ok(triggers.pull_request_target.types.includes('synchronize'), 'a push must re-evaluate');
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
    assert.ok(checkout);
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
  });

  test('actions are pinned to a full commit sha', () => {
    for (const step of job.steps.filter((s) => typeof s.uses === 'string')) {
      assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
    }
  });

  test('no run: script interpolates a ${{ }} expression', () => {
    for (const step of job.steps.filter((s) => typeof s.run === 'string')) {
      assert.equal(step.run.includes('${{'), false, `step "${step.name}" interpolates an expression into shell`);
    }
  });

  test('the body, title and head sha are read live, not replayed from the event payload', () => {
    const read = job.steps.find((step) => step.name === 'Read the current PR state');
    assert.ok(read, 'the live-read step must exist');
    assert.equal(read.id, 'pr');
    assert.equal(read.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(read.env.REPO, '${{ github.repository }}');
    assert.equal(read.env.PR_NUMBER, '${{ github.event.pull_request.number }}');
    const evaluate = job.steps.find((step) => step.name === 'Evaluate');
    assert.equal(evaluate.env.PR_BODY_FILE, '${{ steps.pr.outputs.body_file }}');
    assert.equal(evaluate.env.PR_TITLE_FILE, '${{ steps.pr.outputs.title_file }}');
    assert.equal(evaluate.env.HEAD_SHA, '${{ steps.pr.outputs.head_sha }}');
    assert.equal(evaluate.env.PR_BODY, undefined, 'the stale payload body must not reach the policy');
    assert.equal(evaluate.env.PR_TITLE, undefined, 'the stale payload title must not reach the policy');
  });

  test('the remaining payload values (fixed for the life of a PR) reach the policy only through env', () => {
    const evaluate = job.steps.find((step) => step.name === 'Evaluate');
    assert.equal(evaluate.env.HEAD_REF, '${{ github.event.pull_request.head.ref }}');
    assert.equal(evaluate.env.PR_AUTHOR_LOGIN, '${{ github.event.pull_request.user.login }}');
  });

  test('the live-read step writes the body to a file, not to a step output', () => {
    const read = job.steps.find((step) => step.name === 'Read the current PR state');
    // A body can be large and multi-line: GITHUB_OUTPUT would need a delimiter and env has size limits.
    assert.equal(read.run.includes('pr-body.txt'), true);
    assert.equal(/echo "body=/.test(read.run), false);
  });

  test('runs the policy script from the checked-out base, not a PR path', () => {
    const evaluate = job.steps.find((step) => step.name === 'Evaluate');
    assert.equal(evaluate.run, 'node scripts/self-test-report-policy.cjs');
  });

  test('queue runs do not share one concurrency group', () => {
    assert.match(doc.concurrency.group, /github\.event\.pull_request\.number \|\| github\.ref/);
  });
});

describe('#5612: advisory contract and template', () => {
  test('is not a required status check on any committed ruleset', () => {
    const dir = path.join(ROOT, '.github', 'rulesets');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const rule of spec.rules) {
        const contexts = rule.type === 'required_status_checks'
          ? rule.parameters.required_status_checks.map((c) => c.context)
          : [];
        assert.equal(contexts.includes('Self-test report'), false, `${file} requires it before the trial`);
      }
    }
  });

  test('the fix template carries a Self-test report section with a json block', () => {
    const { extractReport } = require('../scripts/self-test-report-policy.cjs');
    const template = fs.readFileSync(path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE', 'fix.md'), 'utf8');
    const got = extractReport(template);
    assert.equal(got.found, true);
    const parsed = JSON.parse(got.json);
    assert.equal(parsed.schema, 1);
  });

  test('the template as shipped does not itself validate, so a PR cannot pass by leaving it untouched', () => {
    const { evaluateSelfTestReport } = require('../scripts/self-test-report-policy.cjs');
    const template = fs.readFileSync(path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE', 'fix.md'), 'utf8');
    const verdict = evaluateSelfTestReport({
      body: template,
      headRef: 'fix/1-x',
      title: 'fix: x',
      authorLogin: 'outsider',
      headSha: 'a'.repeat(40),
      maintainers: new Set(['trek-e']),
    });
    assert.equal(verdict.ok, false);
  });
});
