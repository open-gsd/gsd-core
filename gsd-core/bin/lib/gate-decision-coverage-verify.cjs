"use strict";
/**
 * `check decision-coverage-verify` — advisory verify-phase decision-coverage gate, as a gate
 * module (#5139, epic #5056, ADR-5057 §4 first bullet): it returns a `GateResult`; the command
 * router formats it. Always `blocking:false` — a soft warning, never a verification failure.
 * Imports no io module and performs no direct console/stdout/stderr write (ESLint-enforced).
 *
 * Argv after the verb: `<phase-dir> <context-path>` (positional; no `--context` flag here).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateDecisionCoverageVerify = evaluateDecisionCoverageVerify;
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_phase_context_cjs_1 = require("./gate-phase-context.cjs");
const gate_config_cjs_1 = require("./gate-config.cjs");
const decision_coverage_support_cjs_1 = require("./decision-coverage-support.cjs");
/**
 * The verdict when CONTEXT.md or a shipped artifact could not be read. The gate stays advisory
 * (`block: false`, `blocking: false`); the outcome is `unreadable`, so the exit status is
 * UNAVAILABLE and no decision is reported honored or not honored from content never seen (#5170).
 */
function unreadableVerify(readError) {
    return (0, gate_verdict_cjs_1.gateUnreadable)(false, {
        skipped: false,
        blocking: false,
        reason: 'unreadable evidence',
        total: null,
        honored: null,
        not_honored: [],
        readError,
        message: `Decision coverage verify (warning): could not read its evidence (${readError}); no decision was checked.`,
    });
}
/** The verdict when there is no CONTEXT.md: the legitimate green skip (authoritatively `none`, never `unreadable`). */
function contextMissingSkip() {
    return (0, gate_verdict_cjs_1.gateVerdict)('skip', false, { skipped: true, blocking: false, reason: 'CONTEXT.md missing', total: 0, honored: 0, not_honored: [], message: 'No CONTEXT.md - nothing to check.' });
}
function evaluateDecisionCoverageVerify(input) {
    const { projectDir, args } = input;
    let phaseDir = '';
    if (args[0]) {
        const resolved = (0, gate_phase_context_cjs_1.resolveContainedPath)(args[0], projectDir);
        if ((0, gate_verdict_cjs_1.isGateUsageFailure)(resolved))
            return resolved;
        phaseDir = resolved;
    }
    let contextPath = '';
    if (args[1]) {
        const resolved = (0, gate_phase_context_cjs_1.resolveContainedPath)(args[1], projectDir);
        if ((0, gate_verdict_cjs_1.isGateUsageFailure)(resolved))
            return resolved;
        contextPath = resolved;
    }
    if (!(0, gate_config_cjs_1.isDecisionCoverageGateEnabled)(projectDir)) {
        return (0, gate_verdict_cjs_1.gateVerdict)('skip', false, { skipped: true, blocking: false, reason: 'workflow.context_coverage_gate is false', total: 0, honored: 0, not_honored: [], message: 'Decision coverage gate disabled by config.' });
    }
    // No context argument is the only up-front skip: an absent file is `none` and an unreadable one is
    // `unreadable` below, from the one read that loads the decisions (`fs.existsSync` answered `false`
    // for an EACCES on a parent, skipping a CONTEXT.md the gate never saw — #5170).
    if (!contextPath) {
        return contextMissingSkip();
    }
    const extracted = (0, decision_coverage_support_cjs_1.loadDecisionExtraction)(contextPath);
    if (extracted.kind === 'unreadable')
        return unreadableVerify(`${extracted.span ?? contextPath}: ${extracted.reason}`);
    if (extracted.kind === 'none') {
        return contextMissingSkip();
    }
    const { trackable: decisions, outcome: decisionOutcome } = extracted.value;
    // Mirror could-not-parse surface for verify (non-blocking advisory WARN).
    // Fire independent of decisions.length — a parse-miss on any bullet must surface,
    // even when some decisions were partially extracted (#1365 fix-parity with plan gate).
    if (decisionOutcome === 'could-not-parse') {
        const partialParse = decisions.length > 0;
        return (0, gate_verdict_cjs_1.gateVerdict)('advisory', false, {
            skipped: false,
            blocking: false,
            reason: 'could-not-parse',
            total: decisions.length,
            honored: 0,
            not_honored: [],
            message: partialParse
                ? 'Decision coverage verify (warning): decisions could not be fully parsed — one or more ' +
                    '`- **D-NN ...**` bullets appear malformed (missing `:` or ` — ` separator, or a phase ' +
                    'prefix that is not a digit run). Fix the bullet format in the CONTEXT.md decisions block.'
                : 'Decision coverage verify (warning): could not parse decisions — possible format mismatch. ' +
                    'Check the formatting of the CONTEXT.md decisions block (accepted forms: `- **D-NN:** text`, ' +
                    '`- **D4-NN:** text` (phase-prefixed), `- **D-NN — title** body`).',
        });
    }
    if (decisions.length === 0) {
        return (0, gate_verdict_cjs_1.gateVerdict)('skip', false, { skipped: true, blocking: false, reason: 'no trackable decisions', total: 0, honored: 0, not_honored: [], message: 'No trackable decisions in CONTEXT.md.' });
    }
    // #4939: mirror the plan gate. A phase-dir argument that names no directory
    // means no plan or summary was scanned, so no decision can be reported
    // not-honored. Warn (verify stays non-blocking) rather than list every decision.
    const phaseDirIssue = phaseDir ? (0, decision_coverage_support_cjs_1.phaseDirProblem)(phaseDir) : null;
    if (phaseDirIssue) {
        const phaseDirResult = { skipped: false, blocking: false, reason: phaseDirIssue.reason, total: null, honored: null, not_honored: [], message: `Decision coverage verify (warning): the phase directory "${args[0]}" ${phaseDirIssue.what}, so no plans or summaries were scanned. ${phaseDirIssue.hint}` };
        return phaseDirIssue.unreadable ? (0, gate_verdict_cjs_1.gateUnreadable)(false, phaseDirResult) : (0, gate_verdict_cjs_1.gateVerdict)('advisory', false, phaseDirResult);
    }
    // Every file the haystack is built from is typed evidence (#5170): one that exists but cannot be
    // read is `unreadable`, never an empty slice of the haystack that makes a decision look unhonored.
    const planContents = (0, decision_coverage_support_cjs_1.loadPlanContents)(phaseDir);
    if (planContents.kind === 'unreadable')
        return unreadableVerify(`${planContents.span ?? phaseDir}: ${planContents.reason}`);
    const tracker = (0, decision_coverage_support_cjs_1.resolveTrackerBodies)(projectDir, planContents.value, input.deps);
    if (tracker.kind === 'unreadable')
        return unreadableVerify(`${tracker.span}: ${tracker.reason}`);
    const summaryParts = (0, decision_coverage_support_cjs_1.loadSummaryContents)(phaseDir);
    if (summaryParts.kind === 'unreadable')
        return unreadableVerify(`${summaryParts.span ?? phaseDir}: ${summaryParts.reason}`);
    // #4939: mirror the plan gate. A phase directory with no PLAN and no SUMMARY file gave the
    // verifier nothing to read, which is a caller error, not a phase whose decisions were all missed.
    if (phaseDir && planContents.value.length === 0 && summaryParts.value.length === 0) {
        return (0, gate_verdict_cjs_1.gateVerdict)('advisory', false, { skipped: false, blocking: false, reason: 'phase directory holds no plans', total: null, honored: null, not_honored: [], message: `Decision coverage verify (warning): the phase directory "${args[0]}" holds no PLAN or SUMMARY files, so nothing was scanned. Pass the phase DIRECTORY that holds the plans (e.g. .planning/phases/01-slug), not the phase number.` });
    }
    const modifiedFiles = (0, decision_coverage_support_cjs_1.readModifiedFilesContent)(projectDir, summaryParts.value);
    if (modifiedFiles.kind === 'unreadable')
        return unreadableVerify(`${modifiedFiles.span ?? 'files_modified'}: ${modifiedFiles.reason}`);
    const haystack = [
        planContents.value.map((c, i) => c + (tracker.value.bodies[i] ? '\n' + tracker.value.bodies[i] : '')).join('\n\n'),
        summaryParts.value.join('\n\n'),
        modifiedFiles.value,
        (0, decision_coverage_support_cjs_1.phaseCommitMessages)(projectDir, phaseDir),
    ].join('\n\n');
    const notHonored = [];
    let honored = 0;
    for (const decision of decisions) {
        if ((0, decision_coverage_support_cjs_1.decisionMentioned)(haystack, decision))
            honored++;
        else
            notHonored.push({ id: decision.id, text: decision.text, category: decision.category });
    }
    if (notHonored.length > 0 && tracker.value.missingResolver)
        return unreadableVerify(`${tracker.value.missingResolver.span}: ${tracker.value.missingResolver.reason}`);
    return (0, gate_verdict_cjs_1.gateVerdict)(notHonored.length === 0 ? 'pass' : 'advisory', false, {
        skipped: false,
        blocking: false,
        total: decisions.length,
        honored,
        not_honored: notHonored,
        message: (0, decision_coverage_support_cjs_1.buildVerifyMessage)(notHonored),
    });
}
