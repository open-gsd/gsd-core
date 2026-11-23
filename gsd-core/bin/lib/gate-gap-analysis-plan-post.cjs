"use strict";
/**
 * `check gap-analysis-plan-post` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet):
 * it returns a `GateResult`; the command router formats it. Imports no io module and performs no
 * direct console/stdout/stderr write (ESLint-enforced).
 *
 * Non-blocking advisory check that runs the post-planning gap analysis after all PLAN.md files are
 * generated for a phase. Cross-references every REQ-ID and D-ID from REQUIREMENTS.md and CONTEXT.md
 * against the concatenated text of all *-PLAN.md files, emitting a coverage table.
 *
 * This gate is always advisory (`passed: true`, `block: false`) — it never blocks phase advancement.
 *
 * Argv after the verb: `<phase-dir> [phase-req-ids]`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateGapAnalysisPlanPost = evaluateGapAnalysisPlanPost;
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_phase_context_cjs_1 = require("./gate-phase-context.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gapCheckerModule = require("./gap-checker.cjs");
const { runGapAnalysis } = gapCheckerModule;
function evaluateGapAnalysisPlanPost(input) {
    const { projectDir, args } = input;
    const phaseDir = args[0] || '';
    if (!phaseDir) {
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.SDK_MISSING_ARG, 'gap-analysis.plan-post requires a phase-dir argument: check gap-analysis.plan-post <phase-dir> [phase-req-ids]');
    }
    const resolvedPhaseDir = (0, gate_phase_context_cjs_1.resolveContainedPath)(phaseDir, projectDir);
    if ((0, gate_verdict_cjs_1.isGateUsageFailure)(resolvedPhaseDir))
        return resolvedPhaseDir;
    const phaseReqIds = args[1] ?? undefined;
    const result = runGapAnalysis(projectDir, resolvedPhaseDir, { phaseReqIds });
    // Uniform gate contract: block = false (gap-analysis is always advisory, never blocks).
    // `message` carries the human-readable gap analysis report so the dispatch's advisory branch can
    // surface it.
    // #5170 (ADR-5057 §4): a REQUIREMENTS.md, CONTEXT.md, plan, config or phase directory that exists but
    // could not be read means the table was computed over evidence the analysis never saw. The gate
    // stays advisory (`block: false`) but the outcome is `unreadable`: exit UNAVAILABLE, never a clean pass.
    if (result.unreadable !== undefined && result.unreadable.length > 0) {
        const named = result.unreadable.map((u) => `${u.span} (${u.reason})`).join('; ');
        return (0, gate_verdict_cjs_1.gateUnreadable)(false, {
            block: false,
            passed: false,
            enabled: result.enabled,
            table: result.table,
            summary: result.summary,
            counts: result.counts,
            unreadable: result.unreadable,
            message: `${result.table || result.summary || ''}\nPost-planning gap analysis could not read its evidence: ${named}.`,
        });
    }
    return (0, gate_verdict_cjs_1.gateVerdict)('advisory', false, {
        block: false,
        passed: true,
        enabled: result.enabled,
        table: result.table,
        summary: result.summary,
        counts: result.counts,
        message: result.table || result.summary || '',
    });
}
