'use strict';

// Execute-phase worktree shared-artifact ownership (#1571) and the isolated-run recovery fail-safe (#1292): the worktree
// executor's success_criteria must not require STATE.md or ROADMAP.md (the orchestrator owns those writes after each
// wave) but still require SUMMARY.md, the sequential executor's still require both, `roadmap update-plan-progress` is
// orchestrator-owned and the ghost `state update-position` stays gone; execute-phase.md points to the extracted
// worktree-recovery-policy.md fragment, which carries the ISOLATED-RUN RECOVERY guardrail and the fail-closed rule, and
// quick.md carries the same guardrail. The success_criteria block of a mode is read by indexOf, from the mode marker to
// the first closing tag after the next opening tag (the test's lazy `[\s\S]*?`). A missing `isolation="worktree"` or
// `**Sequential mode**` marker is a finding (the test passed vacuously without either). Each file is one document. Was
// tests/execute-phase-worktree-artifacts.test.cjs.

const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';
const QUICK = 'gsd-core/workflows/quick.md';
const POLICY = 'gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md';
const OPEN = '<success_criteria>';
const CLOSE = '</success_criteria>';

// The success_criteria text after a mode marker, or the reason it is missing.
function criteriaOf(text, marker) {
  const at = text.indexOf(marker);
  const open = at === -1 ? -1 : text.indexOf(OPEN, at + marker.length);
  const close = open === -1 ? -1 : text.indexOf(CLOSE, open + OPEN.length);
  return close === -1 ? { error: `no success_criteria block follows ${marker}` } : { criteria: text.slice(open + OPEN.length, close) };
}

// The assertion over the success_criteria block of a mode; a block that is missing is reported once (by `once`).
const criteriaCheck = (once) => (marker, needle, present) => (text) => {
  const found = criteriaOf(text, marker);
  if (found.error) return once(found.error);
  return found.criteria.includes(needle) === present || (present ? `the block does not mention ${needle}` : `the block mentions ${needle}`);
};

module.exports = {
  walkers: { criteriaOf },
  id: 'execute-phase-worktree-artifacts',
  issue: '#1571',
  check(ctx) {
    const seen = new Set();
    const criteria = criteriaCheck((message) => {
      if (seen.has(message)) return true;
      seen.add(message);
      return message;
    });
    ctx.doc(EXECUTE_PHASE)
      .satisfies(criteria('**Worktree mode**', 'STATE.md', false), 'the worktree executor success_criteria must not reference STATE.md (the orchestrator owns this write)')
      .satisfies(criteria('**Worktree mode**', 'ROADMAP.md', false), 'the worktree executor success_criteria must not reference ROADMAP.md (the orchestrator owns this write)')
      .satisfies(criteria('**Worktree mode**', 'SUMMARY.md', true), 'the worktree executor success_criteria must still require SUMMARY.md creation')
      .satisfies(criteria('**Sequential mode**', 'STATE.md', true), 'the sequential executor success_criteria must still require the STATE.md update')
      .satisfies(criteria('**Sequential mode**', 'ROADMAP.md', true), 'the sequential executor success_criteria must still require the ROADMAP.md update')
      .has('roadmap update-plan-progress', 'the post-wave section must contain the orchestrator-owned roadmap update-plan-progress command')
      .satisfies((text) => {
        const command = text.indexOf('roadmap update-plan-progress');
        const start = text.indexOf('isolation="worktree"');
        const end = text.indexOf('**Sequential mode**');
        if (start === -1) return 'the isolation="worktree" marker is missing';
        // A missing **Sequential mode** marker is already reported by the sequential success_criteria assertions.
        if (end === -1) return true;
        return command < start || command > end || 'it sits inside the worktree agent prompt';
      }, 'roadmap update-plan-progress must appear outside the worktree agent prompt (orchestrator-owned)')
      .lacks('state update-position', 'state update-position was a ghost reference (the command never existed) and must stay removed')
      .has('execute-phase/steps/worktree-recovery-policy.md', 'execute-phase.md must reference the extracted worktree-recovery-policy.md fragment')
      .has('#1292', 'execute-phase.md must reference #1292 in the worktree recovery policy pointer')
      .has('declines to merge a worktree', 'the step 5.5 pointer must mention "declines to merge a worktree" as the trigger for the fail-safe policy')
      .has('never default to editing', 'the step 5.5 pointer must state "never default to editing" main');

    ctx.doc(POLICY)
      .has('ISOLATED-RUN RECOVERY', 'the fragment must contain the ISOLATED-RUN RECOVERY guardrail label')
      .has('#1292', 'the ISOLATED-RUN RECOVERY guardrail must reference #1292')
      .has('never the proposed or default', 'the guardrail must state editing main is "never the proposed or default" option')
      .has('fresh, narrowly-scoped worktree', 'the guardrail must offer a "fresh, narrowly-scoped worktree" as the recovery path')
      .has('explicit, clearly-labeled confirmation', 'the guardrail must require "explicit, clearly-labeled confirmation" before editing the primary checkout')
      .has('worktree_branch_check', 'the fragment must contain "worktree_branch_check" from the FAIL-CLOSED rule (#48)')
      .has('42', 'the fragment must contain "42" (exit 42) from the FAIL-CLOSED rule (#48)');

    ctx.doc(QUICK)
      .has('ISOLATED-RUN RECOVERY', 'quick.md must contain the ISOLATED-RUN RECOVERY guardrail label')
      .has('#1292', 'the quick.md ISOLATED-RUN RECOVERY guardrail must reference #1292')
      .has('never the proposed or default', 'the quick.md guardrail must state editing main is "never the proposed or default" option')
      .has('fresh, narrowly-scoped worktree', 'the quick.md guardrail must offer a "fresh, narrowly-scoped worktree" as the recovery path')
      .has('explicit, clearly-labeled confirmation', 'the quick.md guardrail must require "explicit, clearly-labeled confirmation" before editing the primary checkout');
  },
};
