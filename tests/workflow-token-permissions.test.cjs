'use strict';

// Behavioral contract: a workflow step that enables GitHub native auto-merge
// (`gh pr merge --auto`) calls the enablePullRequestAutoMerge GraphQL mutation,
// which needs BOTH `pull-requests: write` and `contents: write` on GITHUB_TOKEN.
// Declaring any `permissions` block resets every unlisted scope to `none`, so
// the effective permissions (job-level overrides workflow-level) are checked.
// Regression: the Dependabot Auto-Merge workflow declared only
// `pull-requests: write` and failed with "Resource not accessible by
// integration (enablePullRequestAutoMerge)" (#5136).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');

const AUTO_MERGE_CMD = /gh\s+pr\s+merge\b[^\n]*--auto\b/;

function loadWorkflow(file) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8'));
}

// Effective permission scopes for a job: a job-level block replaces the
// workflow-level block entirely; absence of both means repo defaults (unknown).
function effectivePermissions(workflow, job) {
  const declared = job.permissions !== undefined ? job.permissions : workflow.permissions;
  return declared === undefined ? null : declared;
}

function autoMergeJobs(workflow) {
  return Object.entries(workflow.jobs || {}).filter(([, job]) =>
    (job.steps || []).some((step) => typeof step.run === 'string' && AUTO_MERGE_CMD.test(step.run)),
  );
}

describe('workflow GITHUB_TOKEN permissions for native auto-merge (#5136)', () => {
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  test('dependabot-auto-merge.yml enables auto-merge (guards against the check going vacuous)', () => {
    const workflow = loadWorkflow('dependabot-auto-merge.yml');
    assert.equal(autoMergeJobs(workflow).length, 1);
  });

  for (const file of files) {
    const workflow = loadWorkflow(file);
    for (const [name, job] of autoMergeJobs(workflow)) {
      test(`${file} job "${name}" grants contents: write and pull-requests: write`, () => {
        const perms = effectivePermissions(workflow, job);
        assert.ok(perms && typeof perms === 'object', 'auto-merge job must declare explicit permissions');
        assert.equal(perms.contents, 'write');
        assert.equal(perms['pull-requests'], 'write');
      });
    }
  }
});
