'use strict';

// ADR-15: /gsd:progress --next --auto --converge (#1190). The progress command, the next workflow and
// their docs are runtime-loaded contracts; their text is the shipped slash-command behavior.
// Was tests/adr-15-progress-converge.test.cjs. The case that runs `gsd-tools review-lane flags` is a
// process case and stays a test (tests/review-lane-flags-roster.test.cjs).

const { assertConvergeArgsForwarded } = require('./lib/converge-flags.cjs');

const COMMAND = 'commands/gsd/progress.md';
const WORKFLOW = 'gsd-core/workflows/next.md';
const FULL_MD = 'gsd-core/workflows/help/modes/full.md';
const COMMANDS_DOC = 'docs/COMMANDS.md';
const HOW_TO = 'docs/how-to/run-phases-autonomously.md';

function check(ctx) {
  // progress command advertises --converge, --auto, and notes --cross-ai alias
  ctx.doc(COMMAND)
    .has(/^argument-hint:.*--converge/m, 'progress command should advertise --converge in argument-hint')
    .has(/^argument-hint:.*--auto/m, 'progress command should advertise --auto in argument-hint')
    .has(/--cross-ai/, 'progress command should document --cross-ai alias')
    .has(/workflow\.plan_review_convergence=true/, 'progress command should mention the convergence feature gate');

  const workflow = ctx.doc(WORKFLOW);

  // next workflow parses converge aliases into a plan strategy
  workflow
    .has(/PLAN_STRATEGY="local"/, 'workflow should default to local planning')
    .has(/PLAN_STRATEGY="converge"/, 'workflow should opt into converge planning')
    .has(/converge\|cross-ai/, 'workflow should accept --converge and --cross-ai');

  // next workflow fails fast when convergence is requested but disabled
  workflow
    .has(/config-get workflow\.plan_review_convergence/, 'workflow should check workflow.plan_review_convergence before planning')
    .has(/gsd config-set workflow\.plan_review_convergence true/, 'workflow should print the enable command instead of silently downgrading');

  // next workflow routes Route 3 through plan-review-convergence when PLAN_STRATEGY=converge
  workflow
    .has(/\/gsd:plan-review-convergence/, 'next workflow should reference /gsd:plan-review-convergence for the converge route')
    .has(/PLAN_STRATEGY=converge/, 'next workflow should check PLAN_STRATEGY for the converge override')
    .has(/gsd:plan-phase/, 'local planning path should remain available for default next runs')
    // Args-forwarding contract: the Route 3 invocation must pass ${CONVERGENCE_ARGS} to the command.
    .has(/\/gsd:plan-review-convergence[^\n]*\$\{CONVERGENCE_ARGS\}/, 'Route 3 convergence invocation must include ${CONVERGENCE_ARGS} on the same line as the command');

  // next workflow forwards reviewer flags and max cycles to convergence
  assertConvergeArgsForwarded(workflow, 'workflow');

  // next workflow preserves --auto re-invocation chaining
  workflow
    .has(/--auto/, 'workflow should document the --auto chaining behavior')
    .has(/\/gsd:progress --next --auto/, 'workflow should re-invoke /gsd:progress --next --auto for chaining')
    .has(/\/gsd:progress --next --auto[^\n]*(forwarding|--converge)/, 'workflow --auto re-invocation should document forwarding --converge/--cross-ai and reviewer flags');

  // full.md documents --converge, --auto, and --cross-ai for /gsd:progress
  ctx.doc(FULL_MD)
    .has(/\/gsd:progress --next --auto --converge/, 'full.md should show /gsd:progress --next --auto --converge usage')
    .has(/--auto/, 'full.md should document --auto for progress')
    .has(/--cross-ai/, 'full.md should mention --cross-ai alias for convergence');

  // COMMANDS.md documents progress convergence flags and usage
  ctx.doc(COMMANDS_DOC)
    .has(/\/gsd-progress --next --auto --converge/, 'COMMANDS.md should show /gsd-progress --next --auto --converge usage example')
    .has(/--converge/, 'COMMANDS.md should document --converge for progress')
    .has(/--cross-ai/, 'COMMANDS.md should document --cross-ai alias for progress');

  // how-to shows /gsd-progress --next --auto --converge usage
  ctx.doc(HOW_TO).has(/\/gsd-progress --next --auto --converge/, 'how-to should show /gsd-progress --next --auto --converge usage');
}

module.exports = { id: 'adr-15-progress-converge', issue: '#1190', check };
