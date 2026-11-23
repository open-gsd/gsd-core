'use strict';

// A workflow step that enables GitHub native auto-merge (`gh pr merge --auto`) calls the enablePullRequestAutoMerge
// GraphQL mutation, which needs BOTH `pull-requests: write` and `contents: write` on GITHUB_TOKEN (#5136). A
// `permissions` block resets every unlisted scope to none, so the effective permissions are checked: a job-level
// block replaces the workflow-level one. dependabot-auto-merge.yml must still be found enabling auto-merge, so the
// check cannot go vacuous. Was tests/workflow-token-permissions.test.cjs.

const AUTO_MERGE_CMD = /gh\s{1,20}pr\s{1,20}merge\b[^\n]{0,2000}--auto\b/;

const joinLines = (run) => run.replace(/\\\n\s{0,200}/g, ' '); // a wrapped `gh pr merge \`

function loadWorkflow(text) {
  return require('js-yaml').load(text);
}

// The workflow-level or job-level block, whichever applies; null when neither is declared.
function effectivePermissions(workflow, job) {
  const declared = job.permissions !== undefined ? job.permissions : workflow.permissions;
  return declared === undefined ? null : declared;
}

function autoMergeJobs(workflow) {
  return Object.entries((workflow && workflow.jobs) || {}).filter(([, job]) =>
    (job.steps || []).some((step) => typeof step.run === 'string' && AUTO_MERGE_CMD.test(joinLines(step.run))));
}

module.exports = {
  id: 'workflow-token-permissions',
  issue: '#5136',
  check(ctx) {
    ctx.doc('.github/workflows/dependabot-auto-merge.yml').satisfies((text) => {
      const count = autoMergeJobs(loadWorkflow(text)).length;
      return count === 1 || `found ${count} auto-merge job(s), expected 1`;
    }, 'dependabot-auto-merge.yml must enable auto-merge (guards against the check going vacuous)');

    // The workflows directly under .github/workflows (the test read the directory without descending).
    const files = ctx.list('.github/workflows', '', 'the workflows are what the permissions are checked on')
      .filter((rel) => rel.split('/').length === 3 && /\.ya?ml$/.test(rel));
    for (const rel of files) {
      ctx.doc(rel).satisfies((text) => {
        const workflow = loadWorkflow(text);
        for (const [name, job] of autoMergeJobs(workflow)) {
          const perms = effectivePermissions(workflow, job);
          if (!perms || typeof perms !== 'object') return `job "${name}" must declare explicit permissions`;
          if (perms.contents !== 'write') return `job "${name}" must grant contents: write (has ${JSON.stringify(perms.contents)})`;
          if (perms['pull-requests'] !== 'write') return `job "${name}" must grant pull-requests: write (has ${JSON.stringify(perms['pull-requests'])})`;
        }
        return true;
      }, 'a job that enables native auto-merge must grant contents: write and pull-requests: write');
    }
  },
};
