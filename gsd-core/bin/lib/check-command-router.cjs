"use strict";
/**
 * Check subcommand router — parses argv, dispatches to one gate module per verb, and formats the
 * gate's result (#5139, epic #5056, ADR-5057 §4 first bullet, design D2).
 *
 * The router decides nothing: every gate lives in a `src/gate-<verb>.cts` module (or, for
 * `auto-mode`, `check-auto-mode.cts`) that returns a `GateResult` (`src/gate-verdict.cts`). The
 * router's single output site, `emitGateResult`, prints a verdict's payload or turns a usage
 * failure into `error()`. It imports no filesystem or subprocess primitive (eslint.config.mjs,
 * `no-restricted-imports`; tests/check-router-gate-boundaries.test.cjs).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/check-command-router.cjs collapsed
 * to a TypeScript source of truth.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
const { output, ERROR_REASON } = io;
// Explicitly annotated so TypeScript applies never-return control-flow narrowing.
// A destructured `const { error } = io` is a const WITHOUT a type annotation, and TS
// only narrows after a never-returning call when the callee is a function declaration
// or an annotated const. Without the annotation every `error(...)` guard below would
// need a dead `throw` after it to convince the checker that the value is non-null.
const error = io.error;
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_exit_cjs_1 = require("./gate-exit.cjs");
const gate_args_cjs_1 = require("./gate-args.cjs");
const gate_decision_coverage_plan_cjs_1 = require("./gate-decision-coverage-plan.cjs");
const gate_decision_coverage_verify_cjs_1 = require("./gate-decision-coverage-verify.cjs");
const gate_evaluation_scope_cjs_1 = require("./gate-evaluation-scope.cjs");
const gate_ui_plan_cjs_1 = require("./gate-ui-plan.cjs");
const gate_ui_safety_cjs_1 = require("./gate-ui-safety.cjs");
const gate_tdd_review_checkpoint_cjs_1 = require("./gate-tdd-review-checkpoint.cjs");
const gate_tdd_red_evidence_cjs_1 = require("./gate-tdd-red-evidence.cjs");
const gate_verify_command_paths_cjs_1 = require("./gate-verify-command-paths.cjs");
const gate_verify_failure_directions_cjs_1 = require("./gate-verify-failure-directions.cjs");
const gate_gap_analysis_plan_post_cjs_1 = require("./gate-gap-analysis-plan-post.cjs");
const gate_predicate_cjs_1 = require("./gate-predicate.cjs");
const gate_api_coverage_verify_pre_cjs_1 = require("./gate-api-coverage-verify-pre.cjs");
const decision_coverage_support_cjs_1 = require("./decision-coverage-support.cjs");
const check_auto_mode_cjs_1 = require("./check-auto-mode.cjs");
const gate_schema_drift_cjs_1 = require("./gate-schema-drift.cjs");
const gate_codebase_drift_cjs_1 = require("./gate-codebase-drift.cjs");
const gate_context_drift_cjs_1 = require("./gate-context-drift.cjs");
const gate_prohibition_enforcement_cjs_1 = require("./gate-prohibition-enforcement.cjs");
/** A gate's usage failure as `error()`: the gate's own message, and its code when it is a known reason. */
function failGate(failed) {
    const reason = Object.values(ERROR_REASON).find((value) => value === failed.failure.code);
    return error(failed.failure.message, reason);
}
/**
 * The router's single output site for a gate: a verdict prints its payload; a usage failure
 * fails through `error()` with the gate's own message and code (design D2).
 */
function emitGateResult(result, raw) {
    if ((0, gate_verdict_cjs_1.isGateUsageFailure)(result)) {
        failGate(result);
    }
    output(result.payload, raw, undefined);
    // After output(): it rewrites the pending-outcome cell on every call. Payload mode — a delivered
    // blocking verdict is still exit 0 (the dispatch contract); an unreadable one is UNAVAILABLE (#5170).
    (0, gate_exit_cjs_1.declareGateExit)(result, 'payload');
}
// ─── Thin wrappers: argv[0]='check', argv[1]=verb — a gate takes the argv AFTER the verb ──────────
function cmdAutoMode(projectDir, raw) {
    emitGateResult((0, gate_verdict_cjs_1.gateVerdict)('pass', false, { ...(0, check_auto_mode_cjs_1.readAutoModeState)(projectDir) }), raw);
}
function cmdDecisionCoveragePlan(projectDir, args, raw) {
    emitGateResult((0, gate_decision_coverage_plan_cjs_1.evaluateDecisionCoveragePlan)({ projectDir, args: args.slice(2) }), raw);
}
function cmdDecisionCoverageVerify(projectDir, args, raw) {
    emitGateResult((0, gate_decision_coverage_verify_cjs_1.evaluateDecisionCoverageVerify)({ projectDir, args: args.slice(2) }), raw);
}
function cmdEvaluationScope(projectDir, args, raw) {
    emitGateResult((0, gate_evaluation_scope_cjs_1.evaluateEvaluationScope)({ projectDir, args: args.slice(2) }), raw);
}
function cmdUiPlanGate(projectDir, args, raw) {
    emitGateResult((0, gate_ui_plan_cjs_1.evaluateUiPlanGate)({ projectDir, args: args.slice(2) }), raw);
}
function cmdUiSafetyGate(projectDir, args, raw) {
    emitGateResult((0, gate_ui_safety_cjs_1.evaluateUiSafetyGate)({ projectDir, args: args.slice(2) }), raw);
}
function cmdTddReviewCheckpoint(projectDir, args, raw) {
    emitGateResult((0, gate_tdd_review_checkpoint_cjs_1.evaluateTddReviewCheckpoint)({ projectDir, args: args.slice(2) }), raw);
}
function cmdTddRedEvidence(projectDir, args, raw) {
    emitGateResult((0, gate_tdd_red_evidence_cjs_1.evaluateTddRedEvidence)({ projectDir, args: args.slice(2) }), raw);
}
function cmdVerifyCommandPaths(projectDir, args, raw) {
    emitGateResult((0, gate_verify_command_paths_cjs_1.evaluateVerifyCommandPaths)({ projectDir, args: args.slice(2) }), raw);
}
function cmdVerifyFailureDirections(projectDir, args, raw) {
    emitGateResult((0, gate_verify_failure_directions_cjs_1.evaluateVerifyFailureDirections)({ projectDir, args: args.slice(2) }), raw);
}
function cmdGapAnalysisPlanPost(projectDir, args, raw) {
    emitGateResult((0, gate_gap_analysis_plan_post_cjs_1.evaluateGapAnalysisPlanPost)({ projectDir, args: args.slice(2) }), raw);
}
function cmdCheckPredicate(projectDir, args, raw) {
    emitGateResult((0, gate_predicate_cjs_1.evaluateCheckPredicate)({ projectDir, args: args.slice(2) }), raw);
}
function cmdApiCoverageVerifyPre(projectDir, args, raw) {
    emitGateResult((0, gate_api_coverage_verify_pre_cjs_1.evaluateApiCoverageVerifyPre)({ projectDir, args: args.slice(2) }), raw);
}
/** `GSD_SKIP_SCHEMA_CHECK` is the schema-drift bypass: it arrives as `env`, read here, never by the gate. */
function cmdSchemaDriftGate(projectDir, args, raw, env) {
    emitGateResult((0, gate_schema_drift_cjs_1.evaluateSchemaDriftGate)({ projectDir, args: args.slice(2), env }), raw);
}
function cmdCodebaseDriftGate(projectDir, args, raw) {
    emitGateResult((0, gate_codebase_drift_cjs_1.evaluateCodebaseDriftGate)({ projectDir, args: args.slice(2) }), raw);
}
function cmdContextDriftGate(projectDir, args, raw) {
    emitGateResult((0, gate_context_drift_cjs_1.evaluateContextDriftGate)({ projectDir, args: args.slice(2) }), raw);
}
function cmdProhibitionEnforcement(projectDir, args, raw) {
    emitGateResult((0, gate_prohibition_enforcement_cjs_1.evaluateProhibitionEnforcementGate)({ projectDir, args: args.slice(2) }), raw);
}
function routeCheckCommand({ args, cwd, raw, env = process.env }) {
    // Normalize dots to hyphens in the subcommand so both forms are accepted.
    // This makes `check.query = "ui.plan-gate"` (dotted form in capability.json gates)
    // directly runnable as `gsd_run check ui.plan-gate` — the dot is normalized to
    // `ui-plan-gate` before routing. The generic gate-dispatch in §5.6 reads
    // `check.query` from the active gate hook and runs `gsd_run check ${hook.check.query}`,
    // so the declared query must be dispatchable exactly as declared.
    const rawSubcommand = args[1];
    const subcommand = typeof rawSubcommand === 'string' ? rawSubcommand.replace(/\./g, '-') : rawSubcommand;
    switch (subcommand) {
        case 'auto-mode':
            cmdAutoMode(cwd, raw);
            return;
        case 'decision-coverage-plan':
            cmdDecisionCoveragePlan(cwd, args, raw);
            return;
        case 'decision-coverage-verify':
            cmdDecisionCoverageVerify(cwd, args, raw);
            return;
        case 'evaluation-scope':
            // ADR-5057 §4 / #5164: the one resolver for which commits and files a gate or
            // workflow step evaluates (`--phase N`, `--plan P-N` or `--quick ID`).
            cmdEvaluationScope(cwd, args, raw);
            return;
        case 'ui-plan-gate':
            cmdUiPlanGate(cwd, args, raw);
            return;
        case 'gap-analysis-plan-post':
            cmdGapAnalysisPlanPost(cwd, args, raw);
            return;
        case 'verify-command-paths':
            // Deterministic filesystem probe for <automated> verify commands (#2401) —
            // never executes anything; see verify-command-grounding.cjs.
            cmdVerifyCommandPaths(cwd, args, raw);
            return;
        case 'verify-failure-directions':
            // Presence probe for a stated <fails_when> per <automated> command
            // (#3172) — never executes anything; see verify-command-grounding.cjs.
            cmdVerifyFailureDirections(cwd, args, raw);
            return;
        case 'api-coverage-verify-pre':
            // ai-integration capability blocking gate at verify:pre (#1562). Dot-to-
            // hyphen normalization means query "api-coverage.verify-pre" routes here.
            cmdApiCoverageVerifyPre(cwd, args, raw);
            return;
        case 'tdd-review-checkpoint':
            cmdTddReviewCheckpoint(cwd, args, raw);
            return;
        case 'tdd-red-evidence':
            // #3770: intentional-RED evidence gate — only a target-test failure may
            // authorize GREEN. Validates the persisted record; never executes anything.
            cmdTddRedEvidence(cwd, args, raw);
            return;
        case 'ui-safety-gate':
            cmdUiSafetyGate(cwd, args, raw);
            return;
        case 'verify-schema-drift':
            // The drift capability's gate at execute:wave:post (blocking; src/gate-schema-drift.cts).
            // Dot-to-hyphen normalization means query "verify.schema-drift" routes here.
            // GSD_SKIP_SCHEMA_CHECK=true bypasses the gate: read from `env` here, passed to the gate.
            cmdSchemaDriftGate(cwd, args, raw, env);
            return;
        case 'verify-codebase-drift':
            // The drift capability's gate at execute:wave:post (non-blocking; src/gate-codebase-drift.cts).
            // Dot-to-hyphen normalization means query "verify.codebase-drift" routes here.
            cmdCodebaseDriftGate(cwd, args, raw);
            return;
        case 'verify-context-drift':
            // The drift capability's gate at plan:pre (non-blocking; src/gate-context-drift.cts).
            // Dot-to-hyphen normalization means query "verify.context-drift" routes here.
            cmdContextDriftGate(cwd, args, raw);
            return;
        case 'predicate':
            // Generic gate-predicate evaluator (#2008). The workflow gate-dispatch calls
            // this for any gate whose `check` carries a `predicate` (instead of a `query`),
            // passing the predicate object as --predicate '<json>'. NOTE: unlike the
            // `check.query` subcommands above (which take positional phase args), this
            // subcommand is flag-driven. `decision-coverage-plan` above now ALSO accepts
            // `--context <path>` (its positionals still work) — both share
            // partitionPredicateArgs, the one flag parser.
            cmdCheckPredicate(cwd, args, raw);
            return;
        case 'prohibition-enforcement':
            // The deterministic test-tier prohibition PRODUCER/gate (#1259, ADR-550 D5d). Locates the
            // wired mechanical check (node-test or lint-rule), confirms fail-first, runs it, builds
            // enforcementEvidence, and emits the dispositionForProhibition verdict
            // (src/gate-prohibition-enforcement.cts). Invocable as
            // `gsd_run check prohibition-enforcement <request.json>`.
            cmdProhibitionEnforcement(cwd, args, raw);
            return;
        default:
            error('Unknown check subcommand. Available: api-coverage-verify-pre, auto-mode, decision-coverage-plan, decision-coverage-verify, evaluation-scope, gap-analysis-plan-post, predicate, prohibition-enforcement, tdd-red-evidence, tdd-review-checkpoint, ui-plan-gate, ui-safety-gate, verify-command-paths, verify-failure-directions, verify-schema-drift, verify-codebase-drift, verify-context-drift', ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
}
module.exports = {
    routeCheckCommand,
    decisionMentioned: decision_coverage_support_cjs_1.decisionMentioned,
    extractPlanDesignatedSections: decision_coverage_support_cjs_1.extractPlanDesignatedSections,
    computeUiPlanGate: gate_ui_plan_cjs_1.computeUiPlanGate,
    computeUiSafetyGate: gate_ui_safety_cjs_1.computeUiSafetyGate,
    cmdGapAnalysisPlanPost,
    cmdVerifyCommandPaths,
    cmdVerifyFailureDirections,
    cmdTddReviewCheckpoint,
    cmdTddRedEvidence,
    cmdCheckPredicate,
    buildPredicateDeps: gate_predicate_cjs_1.buildPredicateDeps,
    parsePredicateFlags: gate_args_cjs_1.parsePredicateFlags,
    partitionPredicateArgs: gate_args_cjs_1.partitionPredicateArgs,
    // Fail-closed phase-scope reader for the api-coverage gate — exported for
    // in-process failure-injection tests (#2365 review).
    readPhaseScope: gate_api_coverage_verify_pre_cjs_1.readPhaseScope,
};
