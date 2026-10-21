'use strict';

// #5600 — every required status check on `next` must report on `merge_group`.
//
// GitHub's merge queue builds a temporary commit and waits for each required
// check to report on it. A workflow that supplies a required context but does
// not trigger on `merge_group` never reports, so the queued PR waits for a
// check nothing produces. `test.yml` was wired in #4241; the six PR-metadata
// workflows are wired here.
//
// The contexts come from the ruleset file, not from a list in this test, so a
// context added to the ruleset later is held to the same rule.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const RULESET = path.join(ROOT, '.github', 'rulesets', 'main-protection.json');

/** Workflows whose jobs validate PR metadata and must not execute anything on `merge_group`. */
const METADATA_WORKFLOWS = Object.freeze([
  'branch-naming.yml',
  'changeset-required.yml',
  'docs-required.yml',
  'pr-target-validator.yml',
  'require-issue-link.yml',
  'pr-template-format.yml',
]);

function requiredContexts() {
  const ruleset = JSON.parse(fs.readFileSync(RULESET, 'utf8'));
  const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
  return rule.parameters.required_status_checks.map((c) => c.context);
}

function loadWorkflows() {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((file) => ({
      file,
      doc: yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')),
    }));
}

/** js-yaml may parse the bare key `on` as the string "on" or as boolean true. */
function triggersOf(doc) {
  return doc.on ?? doc[true] ?? {};
}

/** Workflow + job that reports a required context: the job's `name:` if set, else its id. */
function supplierOf(context, workflows) {
  const matches = [];
  for (const { file, doc } of workflows) {
    for (const [id, job] of Object.entries(doc.jobs || {})) {
      if ((job.name ?? id) === context) matches.push({ file, doc, id, job });
    }
  }
  return matches;
}

const GUARD = "github.event_name != 'merge_group'";

/**
 * True only when the expression cannot run on merge_group: the guard is the
 * whole expression, or one `&&` operand of it. Any `||` could re-open the
 * event, so an expression containing one is rejected.
 */
function guardsMergeGroup(expr) {
  if (typeof expr !== 'string' || expr.includes('||')) return false;
  const operands = expr.split('&&').map((o) => o.trim());
  return operands.includes(GUARD);
}

describe('#5600: required contexts report on merge_group', () => {
  const workflows = loadWorkflows();
  const contexts = requiredContexts();

  test('the ruleset lists required contexts', () => {
    assert.ok(contexts.length > 0);
  });

  for (const context of contexts) {
    test(`"${context}" has exactly one supplier that triggers on merge_group`, () => {
      const suppliers = supplierOf(context, workflows);
      assert.equal(suppliers.length, 1, `expected one job reporting "${context}", found ${suppliers.length}`);
      const triggers = triggersOf(suppliers[0].doc);
      assert.ok(
        Object.prototype.hasOwnProperty.call(triggers, 'merge_group'),
        `${suppliers[0].file} supplies "${context}" but does not trigger on merge_group`,
      );
    });
  }
});

describe('#5600: PR-metadata workflows execute nothing on merge_group', () => {
  for (const file of METADATA_WORKFLOWS) {
    const doc = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));

    test(`${file} triggers on merge_group with checks_requested`, () => {
      const trigger = triggersOf(doc).merge_group;
      assert.deepEqual(trigger?.types, ['checks_requested']);
    });

    if (file === 'require-issue-link.yml') {
      test(`${file}: the job stays unconditional and each step carries the guard (#1389)`, () => {
        for (const [id, job] of Object.entries(doc.jobs)) {
          assert.equal(job.if, undefined, `${file} job "${id}" must not be skipped as a whole`);
        }
      });
    }

    test(`${file}: every job or step is skipped on merge_group`, () => {
      // A job skipped by `if:` still reports success for required-check
      // purposes. require-issue-link.yml keeps its job unconditional (#1389)
      // and skips each step instead, so accept either placement, per job.
      for (const [id, job] of Object.entries(doc.jobs)) {
        const jobGuarded = guardsMergeGroup(job.if);
        const stepsGuarded =
          Array.isArray(job.steps) && job.steps.length > 0 && job.steps.every((s) => guardsMergeGroup(s.if));
        assert.ok(jobGuarded || stepsGuarded, `${file} job "${id}" can run on merge_group`);
      }
    });
  }

  test('pr-target-validator.yml: queue runs do not share one concurrency group', () => {
    const doc = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, 'pr-target-validator.yml'), 'utf8'));
    // merge_group carries no pull_request.number; without the ref fallback
    // every queue run in the repo would cancel the others.
    assert.match(doc.concurrency.group, /github\.event\.pull_request\.number \|\| github\.ref/);
  });
});
