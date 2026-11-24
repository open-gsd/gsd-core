'use strict';

// /gsd:autonomous --converge (#711), the verification-deferral contract (#1525, #1526, #1522) and the
// handle_blocker retry ceiling (#3210). The autonomous command and workflow markdown are runtime-loaded
// contracts. Was tests/autonomous-converge.test.cjs; the case that runs `gsd-tools review-lane flags`
// is a process case and stays a test (tests/review-lane-flags-roster.test.cjs).
//
// #2994: fragmentization moved the five converge-gated regions out of the host autonomous.md into
// dedicated step files (state:plan-strategy-converge), see docs/reference/workflow-fragments.md.

const { assertConvergeArgsForwarded } = require('./lib/converge-flags.cjs');

const COMMAND = 'commands/gsd/autonomous.md';
const WORKFLOW = 'gsd-core/workflows/autonomous.md';
const COMMANDS_DOC = 'docs/COMMANDS.md';
const HOW_TO = 'docs/how-to/run-phases-autonomously.md';
const STEPS = 'gsd-core/workflows/autonomous/steps';
const STEP_FAIL_FAST = `${STEPS}/converge-fail-fast.md`;
const STEP_DISPATCH_BG = `${STEPS}/converge-dispatch-bg.md`;
const STEP_DISPATCH_INLINE = `${STEPS}/converge-dispatch-inline.md`;
const STEP_LOOP = `${STEPS}/converge-loop.md`;
const CONVERGENCE_WORKFLOW = 'gsd-core/workflows/plan-review-convergence.md';

const INIT_MANAGER_DEREF = 'if [[ "$INIT_MANAGER" == @file:* ]]; then INIT_MANAGER=$(cat "${INIT_MANAGER#@file:}"); fi';
const STATE_PATH_FROM_INIT = 'STATE_PATH=$(_gsd_field "$INIT_MANAGER" state_path)';
const SKILL_CONVERGENCE = /Skill\(skill="gsd-plan-review-convergence", args="\$\{PHASE_NUM\} \$\{CONVERGENCE_ARGS\}"\)/;

function checkConvergeFlag(ctx) {
  const workflow = ctx.doc(WORKFLOW);

  // command advertises --converge and documents --cross-ai as alias
  ctx.doc(COMMAND)
    .has(/^argument-hint:.*--converge/m, 'autonomous command should advertise --converge in argument-hint')
    .has(/--cross-ai/, 'autonomous command should document --cross-ai alias')
    .has(/workflow\.plan_review_convergence=true/, 'autonomous command should mention the existing convergence feature gate');

  // workflow parses converge aliases into a plan strategy
  workflow
    .has(/PLAN_STRATEGY="local"/, 'workflow should default to local planning')
    .has(/PLAN_STRATEGY="converge"/, 'workflow should opt into converge planning')
    .has(/converge\|cross-ai/, 'workflow should accept --converge and --cross-ai');

  // explicit --converge overrides the config gate (#4600): the contract lives in the converge-fail-fast
  // step file (the host carries only the gated conditional-read stub). An explicit flag must WIN over
  // workflow.plan_review_convergence, so the step must not gate on the config at all and must state the
  // precedence so a runtime agent executes it as written.
  workflow.has(/gsd:section id="converge-fail-fast" when="state:plan-strategy-converge"/, 'workflow should keep the step behind state:plan-strategy-converge');
  ctx.doc(STEP_FAIL_FAST)
    .lacks(/config-get workflow\.plan_review_convergence/, 'the step must not gate an explicit flag on workflow.plan_review_convergence (#4600)')
    .lacks(/exit 1/, 'the step must not stop an explicit-flag run')
    .has(/OVERRIDES the `workflow\.plan_review_convergence` config gate/, 'the step must state that the explicit flag overrides the config gate')
    .has(/invocation carries `--override-gate`/, 'the step must state that the dispatched convergence run carries the override flag (#4600)')
    .has(/without the flag, `PLAN_STRATEGY` is `local`/, 'the step must state that the config is not consulted on the non-flag autonomous path');

  // the dispatched convergence run bypasses the config gate (#4600): the dispatched workflow has its own
  // 1.5 gate that would veto the same run one step later, so the dispatch carries an explicit override.
  const convergence = ctx.doc(CONVERGENCE_WORKFLOW);
  workflow
    .has(/--override-gate/, 'the autonomous converge dispatch must carry --override-gate so the dispatched run cannot be vetoed by the config gate (#4600)')
    .lacks(/fail fast unless the existing convergence feature gate/, 'the host must not instruct a runtime agent to fail fast on the gate before the converge step (#4600)')
    // The override is appended conditionally on the converge strategy, never on local-strategy runs.
    // Searched from the conditional: the host prose at the precedence sentence also names the flag.
    .followedBy('if [ "${PLAN_STRATEGY}" = "converge" ]; then', '--override-gate', 'the PLAN_STRATEGY=converge conditional must exist and append --override-gate (#4600)');
  convergence
    .has(/--override-gate/, 'plan-review-convergence must honor a --override-gate dispatch instead of failing fast (#4600)')
    .has(/gsd-plan-review-convergence is disabled \(workflow\.plan_review_convergence=false\)/, 'the 1.5 veto must remain for standalone invocation, where the config gate decides (#4600)')
    .has('(^|[[:space:]])--override-gate([[:space:]]|$)', '1.5 must match --override-gate token-anchored so no other argument can carry it (#4600)');
  ctx.doc(HOW_TO).has(/overrides the gate for that run/, 'the how-to must document that an explicit --converge overrides the gate on /gsd-autonomous (#4600)');

  // workflow routes planning through plan-review-convergence when enabled: the converge dispatch and loop
  // bodies live in step files now; only the local-planning fallback remains inline in the host.
  ctx.doc(STEP_DISPATCH_INLINE).has(SKILL_CONVERGENCE, 'inline converge dispatch step should call gsd-plan-review-convergence');
  ctx.doc(STEP_LOOP).has(SKILL_CONVERGENCE, 'default converge loop step should call gsd-plan-review-convergence');
  ctx.doc(STEP_DISPATCH_BG).has(
    /Run plan convergence for phase \$\{PHASE_NUM\}: Skill\(skill=\\"gsd-plan-review-convergence\\"/,
    'interactive converge mode should dispatch plan convergence in the background agent',
  );
  workflow.has(/Skill\(skill="gsd-plan-phase", args="\$\{PHASE_NUM\}"\)/, 'local planning path should remain available for default autonomous runs');

  // workflow forwards reviewer flags and max cycles to convergence
  assertConvergeArgsForwarded(workflow, 'workflow');

  // docs show autonomous convergence usage
  ctx.doc(COMMANDS_DOC)
    .has(/--converge/, 'COMMANDS.md should document --converge')
    .has(/--cross-ai/, 'COMMANDS.md should document --cross-ai alias');
  ctx.doc(HOW_TO).has(/\/gsd-autonomous --only 4 --converge/, 'how-to should show single-phase converge usage');
}

function checkVerificationDeferral(ctx) {
  const workflow = ctx.doc(WORKFLOW);

  // workflow records explicit deferred states instead of silently advancing (#1525)
  workflow
    .has(/verification_deferred_human/, 'the human-deferral state must be recorded')
    .has(/verification_deferred_gaps/, 'the gap-deferral state must be recorded')
    .has(/Deferred Verification/, 'deferred verification must be surfaced')
    .has(/gsd:verify-work \$\{PHASE_NUM\}/, 'the human deferral must name the verify-work resume command')
    .has(/gsd:plan-phase \$\{PHASE_NUM\} --gaps/, 'the gap deferral must name the plan-phase --gaps resume command')
    .has(/\| \$\{PHASE_NUM\} \| verification_deferred_human \| \/gsd:verify-work \$\{PHASE_NUM\} \|/, 'human deferral must persist the exact deferred STATE row')
    .has(/\| \$\{PHASE_NUM\} \| verification_deferred_gaps \| \/gsd:plan-phase \$\{PHASE_NUM\} --gaps \|/, 'gap deferral must persist the exact deferred STATE row')
    .lacks(/Human validation deferred` and proceed to iterate step/, 'human-needed deferral must not silently proceed to the next phase')
    .lacks(/Gaps deferred` and proceed to iterate step/, 'gap deferral must not silently proceed to the next phase')
    .has(/Skip deferred phases on autonomous re-entry/, 'reruns must explicitly skip deferred verification phases')
    .has(/Deferred Verification \(Skipped on Re-entry\)/, 'workflow should surface skipped deferred phases and their resume commands');

  // workflow runs normal transition post-processing after passed verification (#1526)
  workflow
    .slice('**If `passed`:**')
    .before('transition.md', 'Proceed to iterate step', 'passed verification must invoke transition.md, and normal transition post-processing must run before autonomous iterates');

  // workflow reads canonical verification status before human-needed promotion (#1522)
  const afterWait = workflow.slice('After execute, read canonical verification');
  afterWait
    .followedBy('**If `human_needed`:**', 'set VERIFICATION frontmatter `status: passed`', 'the human_needed branch must follow the verification status read and contain the promotion action');
  workflow
    .slice('After execute, read canonical verification', '**If `human_needed`:**')
    // #2589: the read uses the native --pick flag (no jq). #5118: stderr kept, and a failed read is a
    // blocker, never `|| true`.
    .has('VERIFY_STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status) || VERIFY_ERROR=1', 'autonomous must route human validation through canonical verification.status via the native --pick flag')
    .lacks(/grep "\^status:"/, 'autonomous must not route stale human_needed reports from raw frontmatter');

  // workflow discovers incomplete phases from canonical verification projection (#1522)
  const discover = workflow.step('discover_phases');
  discover
    .has(/INIT_MANAGER=\$\(gsd_run query init\.manager[^)]*\)/, 'discovery must read init.manager')
    .has(INIT_MANAGER_DEREF, 'autonomous discovery must dereference large init.manager payloads before parsing')
    .has(/phase_complete !== true/, 'discovery must filter on phase_complete')
    .has(/verification_status !== "passed"/, 'discovery must filter on the verification status')
    // #4455: STATE.md is read through the workstream-resolved path from init.manager (state_path), not a
    // hardcoded .planning/STATE.md literal: a GSD_WORKSTREAM run must read its own workstream's STATE.md.
    .has(STATE_PATH_FROM_INIT, 'autonomous discovery must resolve STATE.md through init.manager, not a hardcoded path')
    .has(/STATE_CONTENT=\$\(cat "\$STATE_PATH" 2>\/dev\/null \|\| true\)/, 'discovery must read STATE.md through STATE_PATH')
    .lacks(/STATE_CONTENT=\$\(cat \.planning\/STATE\.md 2>\/dev\/null \|\| true\)/, 'autonomous discovery must not regress to a hardcoded root .planning/STATE.md read (#4455)')
    .has(/drop any phase whose number appears in the deferred-phase map/, 'discovery must drop deferred phases')
    .lacks(/ROADMAP=\$\(gsd_run query roadmap\.analyze\)/, 'discovery must not read the roadmap analysis')
    .lacks(/disk_status !== "complete"/, 'discovery must not filter on disk_status');
  const iterate = workflow.step('iterate');
  iterate
    .has(/INIT_MANAGER=\$\(gsd_run query init\.manager[^)]*\)/, 'iteration must read init.manager')
    .has(INIT_MANAGER_DEREF, 'autonomous iteration must dereference large init.manager payloads before parsing')
    .has(/phase_complete !== true/, 'iteration must filter on phase_complete')
    .has(/verification_status !== "passed"/, 'iteration must filter on the verification status')
    .has(STATE_PATH_FROM_INIT, 'autonomous iteration must resolve STATE.md through init.manager, not a hardcoded path')
    .has(/STATE_CONTENT=\$\(cat "\$STATE_PATH" 2>\/dev\/null \|\| true\)/, 'iteration must read STATE.md through STATE_PATH')
    .lacks(/STATE_CONTENT=\$\(cat \.planning\/STATE\.md 2>\/dev\/null \|\| true\)/, 'autonomous iteration must not regress to a hardcoded root .planning/STATE.md read (#4455)')
    .has(/drop deferred phases from the autonomous queue/, 'iteration must drop deferred phases');
}

// Issue #3210: handle_blocker's "Fix and retry" path had no attempt ceiling across invocations and no
// automatic escalation to a terminal needs_human state, so a non-converging blocker looped indefinitely.
function checkBlockerRetryCeiling(ctx) {
  const step = ctx.doc(WORKFLOW).step('handle_blocker');
  step
    .has(/\b3\b.*retr|\bretr.*\b3\b|RETRY_COUNT|retry (ceiling|limit|count)/i, 'handle_blocker must track a bounded retry count for the same phase step instead of re-presenting "Fix and retry" indefinitely (#3210)')
    .has(/needs_human/, 'once the retry ceiling is exceeded, handle_blocker must halt autonomously in a terminal needs_human state (surfacing the unmet items) instead of looping or asking again (#3210)');
}

function check(ctx) {
  checkConvergeFlag(ctx);
  checkVerificationDeferral(ctx);
  checkBlockerRetryCeiling(ctx);
}

module.exports = { id: 'autonomous-converge', issue: '#711', check };
