'use strict';

// Trust boundary of the "Reviewed or maintainer" workflow (#5607). It reads untrusted PR data under
// `pull_request_target` / `pull_request_review`, which run with the BASE repository's context, so: it checks out the
// BASE sha (never the PR head or merge ref) with no persisted credentials, its token is read-only, no `run:` script
// interpolates `${{ }}` (PR-controlled values reach shell only through `env:`), bot reviewers are never looked up for a
// role, a failed role lookup is reported, the policy script runs from the checked-out base, queue runs do not share a
// concurrency group, it executes nothing on `merge_group`, and it is not yet a required status check on any committed
// ruleset. The workflow and each ruleset are parsed (js-yaml, JSON). Was tests/reviewed-or-maintainer-workflow.test.cjs.

const JOB = 'reviewed-or-maintainer';

// Runs `fn({ doc, job, triggers })` on the parsed workflow, or names why it cannot be parsed.
const onWorkflow = (fn) => (text) => {
  let doc;
  try {
    doc = require('js-yaml').load(text);
  } catch (err) {
    return `not valid YAML: ${err.message}`;
  }
  const job = doc && doc.jobs && doc.jobs[JOB];
  if (!job) return `no ${JOB} job`;
  return fn({ doc, job, triggers: doc.on ?? doc[true] ?? {} });
};
// The steps that are mappings (a null or scalar entry cannot throw a later property read).
const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps.filter((step) => step && typeof step === 'object') : []);
const stepNamed = (job, name) => stepsOf(job).find((step) => step.name === name);

module.exports = {
  id: 'reviewed-or-maintainer-workflow',
  issue: '#5607',
  check(ctx) {
    ctx.doc('.github/workflows/reviewed-or-maintainer.yml')
      .satisfies(onWorkflow(({ job }) => job.name === 'Reviewed or maintainer' || `named ${JSON.stringify(job.name)}`), 'the job must be named for the status context it reports')
      .satisfies(onWorkflow(({ triggers }) => {
        const keys = Object.keys(triggers).sort().join(',');
        if (keys !== 'merge_group,pull_request_review,pull_request_target') return `triggers: ${keys}`;
        const review = triggers.pull_request_review;
        const queue = triggers.merge_group;
        if (!review || typeof review !== 'object') return 'pull_request_review has no configuration';
        if (!queue || typeof queue !== 'object') return 'merge_group has no configuration';
        if (JSON.stringify(review.types) !== '["submitted","dismissed"]') return 'pull_request_review types changed';
        return JSON.stringify(queue.types) === '["checks_requested"]' || 'merge_group types changed';
      }), 'the workflow must trigger on target, review and merge_group events only')
      .satisfies(onWorkflow(({ triggers }) => !Object.prototype.hasOwnProperty.call(triggers, 'pull_request')), 'the plain pull_request trigger, whose workflow file the PR controls, must never be used')
      .satisfies(onWorkflow(({ doc, job }) => {
        if (!doc.permissions || typeof doc.permissions !== 'object') return 'no top-level permissions block';
        for (const [scope, level] of Object.entries(doc.permissions)) {
          if (!['read', 'none'].includes(level)) return `${scope}: ${level} is a write scope`;
        }
        return job.permissions === undefined || 'a job-level permissions block would replace the read-only default';
      }), 'the token must be read-only')
      .satisfies(onWorkflow(({ job }) => job.if === "github.event_name != 'merge_group'" || `if: ${job.if}`), 'the job must be skipped on merge_group')
      .satisfies(onWorkflow(({ job }) => {
        const checkout = stepsOf(job).find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
        if (!checkout) return 'no checkout step';
        if (!checkout.with || checkout.with.ref !== '${{ github.event.pull_request.base.sha }}') return 'checkout ref is not the base sha';
        return checkout.with['persist-credentials'] === false || 'credentials are persisted';
      }), 'the job must check out the base sha and persist no credentials')
      .satisfies(onWorkflow(({ job }) => {
        const bad = stepsOf(job).filter((step) => typeof step.uses === 'string' && !/@[0-9a-f]{40}$/.test(step.uses));
        return bad.length === 0 || bad.map((step) => step.uses).join(', ');
      }), 'actions must be pinned to a full commit sha')
      .satisfies(onWorkflow(({ job }) => {
        const bad = stepsOf(job).filter((step) => typeof step.run === 'string' && step.run.includes('${{'));
        return bad.length === 0 || bad.map((step) => `step "${step.name}"`).join(', ');
      }), 'no run: script may interpolate a ${{ }} expression')
      .satisfies(onWorkflow(({ job }) => {
        const evaluate = stepNamed(job, 'Evaluate');
        if (!evaluate || !evaluate.env) return 'no Evaluate step env';
        if (evaluate.env.PR_AUTHOR_LOGIN !== '${{ github.event.pull_request.user.login }}') return 'PR_AUTHOR_LOGIN changed';
        return evaluate.env.HEAD_SHA === '${{ steps.collect.outputs.head_sha }}' || 'HEAD_SHA is not read live in the collect step';
      }), 'PR-controlled values must reach the policy only through env')
      .satisfies(onWorkflow(({ job }) => {
        const collect = stepNamed(job, 'Collect reviews and reviewer permissions');
        if (!collect) return 'no collect step';
        if (typeof collect.run !== 'string') return 'the collect step has no run script';
        if (!collect.run.includes('[bot]')) return 'the login filter does not mention [bot]';
        return !collect.run.includes('(\\[bot\\])?$') || 'the login filter admits a [bot] suffix';
      }), 'reviewer bots must never be looked up for a role')
      .satisfies(onWorkflow(({ job }) => {
        const collect = stepNamed(job, 'Collect reviews and reviewer permissions');
        if (!collect || typeof collect.run !== 'string') return 'no collect step run script';
        return collect.run.includes('::warning::') || 'no ::warning::';
      }), 'a failed role lookup must be reported, not silently turned into no approval')
      .satisfies(onWorkflow(({ job }) => {
        const evaluate = stepNamed(job, 'Evaluate');
        return (evaluate && evaluate.run === 'node scripts/reviewed-or-maintainer-policy.cjs') || `run: ${evaluate && evaluate.run}`;
      }), 'the policy script must run from the checked-out base, not a PR path')
      .satisfies(onWorkflow(({ doc }) => {
        const group = doc.concurrency && doc.concurrency.group;
        if (typeof group !== 'string') return 'no concurrency group';
        if (!/github\.event\.pull_request\.number \|\| github\.ref/.test(group)) return 'queue runs share a group';
        return /github\.event_name/.test(group) || 'event types cancel each other';
      }), 'queue runs must not share one concurrency group, and event types must not cancel each other');

    for (const rel of ctx.list('.github/rulesets', '.json', 'the committed rulesets are what the required-check rule is read from')) {
      if (rel.split('/').length !== 3) continue; // the test read the directory without descending
      ctx.doc(rel).satisfies((text) => {
        let spec;
        try {
          spec = JSON.parse(text);
        } catch (err) {
          return `not valid JSON: ${err.message}`;
        }
        if (!spec || !Array.isArray(spec.rules)) return 'no rules array';
        for (const rule of spec.rules) {
          if (!rule || typeof rule !== 'object') return 'a rule that is not an object';
          if (rule.type !== 'required_status_checks') continue;
          if (!(rule.parameters && Array.isArray(rule.parameters.required_status_checks))) return 'a required_status_checks rule without its checks list';
          if (rule.parameters.required_status_checks.some((check) => !check || typeof check !== 'object')) return 'a required status check that is not an object';
          if (rule.parameters.required_status_checks.some((check) => check.context === 'Reviewed or maintainer')) return 'requires it';
        }
        return true;
      }, 'Reviewed or maintainer must not be a required status check before the trial');
    }
  },
};
