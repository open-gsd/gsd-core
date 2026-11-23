'use strict';

// `gsd_run check predicate` resolves ${PHASE_DIR}/${PHASE_NUMBER}/${PHASE_REQ_IDS} in a command-exit-zero gate from
// the --phase-dir/--phase-number/--phase-req-ids flags the calling workflow passes (#4483). A dispatch line that
// omits a value the workflow already holds makes a capability gate silently resolve that placeholder to ''. Every
// dispatch line of each listed workflow passes the values that workflow holds; no unlisted workflow dispatches a
// check predicate; and verify-work.md assigns PHASE_DIR and PHASE_NUMBER before dispatching with them (#5289).
// Was tests/check-predicate-dispatch-phase-flags-4483.test.cjs.

const WORKFLOWS = 'gsd-core/workflows';
const DIR = ['--phase-dir', '${PHASE_DIR}'];
const NUM = ['--phase-number', '${PHASE_NUMBER}'];
const REQ = ['--phase-req-ids', '${PHASE_REQ_IDS}'];
// [label, file under gsd-core/workflows, flag -> the live variable it must carry]. These are the values each file
// holds at its dispatch; verify-work.md's verify:pre fence assigns PHASE_DIR and PHASE_NUMBER itself (PHASE_REQ_IDS
// is never assigned), and ship.md never assigns PHASE_REQ_IDS.
const DISPATCHES = [
  ['execute:post (verify-phase-goal)', 'execute-phase/steps/verify-phase-goal.md', [DIR, NUM]],
  ['plan-phase gate dispatch', 'plan-phase.md', [DIR, NUM, REQ]],
  ['plan:pre (plan-pre-dispatch, #5982)', 'plan-phase/steps/plan-pre-dispatch.md', [DIR, NUM, REQ]],
  ['ship gate dispatch', 'ship.md', [DIR, NUM]],
  ['verify-work verify:pre dispatch', 'verify-work.md', [DIR, NUM]],
  ['execute:wave:post (wave-post-gate-hooks)', 'execute-phase/steps/wave-post-gate-hooks.md', [DIR, NUM]],
  ['execute:pre (pre-execute-gate-hooks, #5848)', 'execute-phase/steps/pre-execute-gate-hooks.md', [DIR, NUM]],
];

const dispatchLines = (text) => text.split('\n').filter((line) => line.includes('gsd_run check predicate'));

module.exports = {
  id: 'check-predicate-dispatch-phase-flags-4483',
  issue: '#4483',
  check(ctx) {
    const listed = new Set(DISPATCHES.map(([, file]) => `${WORKFLOWS}/${file}`));
    for (const [label, file, flags] of DISPATCHES) {
      ctx.doc(`${WORKFLOWS}/${file}`).satisfies((text) => {
        const lines = dispatchLines(text);
        if (lines.length < 1) return 'no check predicate dispatch line found';
        for (const line of lines) {
          for (const [flag, value] of flags) {
            if (!line.includes(`${flag} "${value}"`)) return `dispatch omits ${flag} "${value}": ${line.trim()}`;
          }
        }
        return true;
      }, `${label} must pass ${flags.map(([flag]) => flag).join(', ')} on every check predicate dispatch line`);
    }

    // A workflow that dispatches a check predicate and is not listed above: add it to DISPATCHES with the values it holds.
    for (const rel of ctx.list(WORKFLOWS, '.md', 'the workflows are what the dispatch scan covers')) {
      if (listed.has(rel)) continue;
      ctx.doc(rel).satisfies((text) => dispatchLines(text).length === 0,
        'a new check predicate dispatch site must be added to DISPATCHES with the values it holds');
    }

    ctx.doc(`${WORKFLOWS}/verify-work.md`)
      .satisfies((text) => {
        const dispatchAt = text.indexOf('gsd_run check predicate');
        if (dispatchAt === -1) return 'no check predicate dispatch found';
        const fence = text.slice(text.lastIndexOf('```bash', dispatchAt), dispatchAt);
        const assignedAt = text.indexOf('PHASE_DIR=$(');
        return /PHASE_DIR=\$\(/.test(fence) || (assignedAt !== -1 && assignedAt < dispatchAt);
      }, 'PHASE_DIR must be assigned before the dispatch (#5289)')
      .satisfies((text) => {
        const dispatchAt = text.indexOf('gsd_run check predicate');
        const assignedAt = text.indexOf("PHASE_NUMBER=$(printf '%s' \"$INIT\"");
        return dispatchAt !== -1 && assignedAt !== -1 && assignedAt < dispatchAt;
      }, 'PHASE_NUMBER must be assigned from the init JSON before the dispatch (#5289)');
  },
};
