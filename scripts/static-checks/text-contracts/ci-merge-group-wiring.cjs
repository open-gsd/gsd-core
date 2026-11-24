'use strict';

// Every required status check on `next` reports on `merge_group` (#5600): GitHub's merge queue builds a temporary
// commit and waits for each required check to report on it, so a workflow that supplies a required context but does
// not trigger on `merge_group` never reports. The contexts come from the ruleset file, not from a list here, so a
// context added later is held to the same rule. The six PR-metadata workflows trigger on merge_group (checks_requested)
// and execute nothing there: each job, or each step of a job that stays unconditional (#1389), is skipped by the
// `github.event_name != 'merge_group'` guard. Workflows are parsed with js-yaml's safe `load`; an unparseable file or
// a malformed structure is a finding for that file, where the test threw. Was tests/ci-merge-group-wiring.test.cjs.

const WORKFLOWS_DIR = '.github/workflows';
const RULESET = '.github/rulesets/main-protection.json';
const GUARD = "github.event_name != 'merge_group'";
const METADATA_WORKFLOWS = [
  'branch-naming.yml',
  'changeset-required.yml',
  'docs-required.yml',
  'pr-target-validator.yml',
  'require-issue-link.yml',
  'pr-template-format.yml',
];

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// js-yaml may parse the bare key `on` as the string "on" or as boolean true.
function triggersOf(doc) {
  const triggers = doc.on ?? doc[true] ?? {};
  return isMapping(triggers) ? triggers : {};
}

// True only when the expression cannot run on merge_group: the guard is the whole expression, or one `&&` operand of
// it. Any `||` could re-open the event, so an expression containing one is rejected.
function guardsMergeGroup(expr) {
  if (typeof expr !== 'string' || expr.includes('||')) return false;
  return expr.split('&&').map((operand) => operand.trim()).includes(GUARD);
}

// The parsed workflow, or the reason it cannot be used.
function parseWorkflow(text) {
  let doc;
  try {
    doc = require('js-yaml').load(text);
  } catch (err) {
    return { error: `not valid YAML: ${err.message}` };
  }
  return isMapping(doc) ? { doc } : { error: 'the workflow is not a mapping' };
}

// The required status check contexts of the ruleset, or the reason there are none.
function requiredContexts(text) {
  let ruleset;
  try {
    ruleset = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${err.message}` };
  }
  const rules = isMapping(ruleset) && Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const rule = rules.find((candidate) => isMapping(candidate) && candidate.type === 'required_status_checks');
  const checks = rule && isMapping(rule.parameters) ? rule.parameters.required_status_checks : null;
  if (!Array.isArray(checks)) return { error: 'the ruleset has no required_status_checks rule with a list of checks' };
  return { contexts: checks.filter(isMapping).map((check) => check.context) };
}

module.exports = {
  id: 'ci-merge-group-wiring',
  issue: '#5600',
  check(ctx) {
    // The workflows directly under .github/workflows (the test read the directory without descending).
    const workflows = new Map();
    for (const rel of ctx.list(WORKFLOWS_DIR, '.yml', 'the workflows are what the merge_group wiring is checked on').filter((file) => file.split('/').length === 3)) {
      ctx.doc(rel).satisfies((text) => {
        const parsed = parseWorkflow(text);
        if (parsed.error) return parsed.error;
        workflows.set(rel.split('/')[2], parsed.doc);
        return true;
      }, 'the workflow must parse');
    }

    const ruleset = ctx.doc(RULESET);
    let contexts = [];
    ruleset.satisfies((text) => {
      const required = requiredContexts(text);
      if (required.error) return required.error;
      contexts = required.contexts;
      return contexts.length > 0 || 'no required contexts';
    }, 'the ruleset must list required contexts');

    for (const context of contexts) {
      ruleset.satisfies(() => {
        const suppliers = [];
        for (const [file, doc] of workflows) {
          if (!isMapping(doc.jobs)) continue;
          for (const [id, job] of Object.entries(doc.jobs)) {
            if (isMapping(job) && (job.name ?? id) === context) suppliers.push({ file, doc });
          }
        }
        if (suppliers.length !== 1) return `expected one job reporting "${context}", found ${suppliers.length}`;
        return Object.prototype.hasOwnProperty.call(triggersOf(suppliers[0].doc), 'merge_group')
          || `${suppliers[0].file} supplies "${context}" but does not trigger on merge_group`;
      }, `the required context "${context}" must have exactly one supplier that triggers on merge_group`);
    }

    for (const file of METADATA_WORKFLOWS) {
      const doc = ctx.doc(`${WORKFLOWS_DIR}/${file}`);
      const withWorkflow = (check) => (text) => {
        const parsed = parseWorkflow(text);
        return parsed.error || check(parsed.doc);
      };
      doc.satisfies(withWorkflow((workflow) => {
        const trigger = triggersOf(workflow).merge_group;
        const types = isMapping(trigger) ? trigger.types : undefined;
        return (Array.isArray(types) && types.length === 1 && types[0] === 'checks_requested') || `merge_group types: ${JSON.stringify(types)}`;
      }), `${file} must trigger on merge_group with checks_requested`);

      if (file === 'require-issue-link.yml') {
        doc.satisfies(withWorkflow((workflow) => {
          for (const [id, job] of Object.entries(isMapping(workflow.jobs) ? workflow.jobs : {})) {
            if (isMapping(job) && job.if !== undefined) return `job "${id}" is skipped as a whole`;
          }
          return true;
        }), `${file}: the job must stay unconditional and each step carry the guard (#1389)`);
      }

      // A job skipped by `if:` still reports success for required-check purposes; require-issue-link.yml keeps its job
      // unconditional (#1389) and skips each step instead, so either placement counts, per job.
      doc.satisfies(withWorkflow((workflow) => {
        if (!isMapping(workflow.jobs) || Object.keys(workflow.jobs).length === 0) return 'the workflow has no jobs mapping';
        for (const [id, job] of Object.entries(workflow.jobs)) {
          if (!isMapping(job)) return `job "${id}" is not a mapping`;
          const jobGuarded = guardsMergeGroup(job.if);
          if (!jobGuarded && Array.isArray(job.steps)) {
            const bad = job.steps.findIndex((step) => !isMapping(step));
            if (bad !== -1) return `job "${id}" step ${bad + 1} is not a mapping`;
          }
          const stepsGuarded = Array.isArray(job.steps) && job.steps.length > 0
            && job.steps.every((step) => isMapping(step) && guardsMergeGroup(step.if));
          if (!(jobGuarded || stepsGuarded)) return `job "${id}" can run on merge_group`;
        }
        return true;
      }), `${file}: every job or step must be skipped on merge_group`);
    }

    // merge_group carries no pull_request.number; without the ref fallback every queue run in the repo would cancel the others.
    ctx.doc(`${WORKFLOWS_DIR}/pr-target-validator.yml`).satisfies((text) => {
      const parsed = parseWorkflow(text);
      if (parsed.error) return parsed.error;
      const group = isMapping(parsed.doc.concurrency) ? parsed.doc.concurrency.group : undefined;
      return (typeof group === 'string' && /github\.event\.pull_request\.number \|\| github\.ref/.test(group)) || `concurrency group: ${JSON.stringify(group)}`;
    }, 'pr-target-validator.yml: queue runs must not share one concurrency group');
  },
};
