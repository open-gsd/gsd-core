"use strict";
/**
 * `check verify-context-drift` as a gate module (#5219, epic #5056, ADR-5057 §4 closing arm C): it
 * returns a `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * The `drift` capability's gate at `plan:pre` (#3348). It reports the phase's upstream artifacts
 * (RESEARCH, PATTERNS, VALIDATION, SPEC) whose effective last-changed time is STRICTLY BEFORE the
 * phase CONTEXT.md's own: the decisions moved after the artifact was written. Non-blocking unless
 * `workflow.context_drift_action` is `block`.
 *
 * Dispatched gate, payload exit mode (see `gate-schema-drift.cts`): a blocking verdict is exit 0 and
 * "could not look" is exit 69 (#5170).
 *
 * Non-blocking contract: a throw anywhere (an invalid GSD_WORKSTREAM, an unreadable file) yields a
 * non-blocking `unreadable` verdict, never a crash.
 *
 * Argv after the verb: `<phase>`.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeContextDrift = computeContextDrift;
exports.evaluateContextDriftGate = evaluateContextDriftGate;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const gate_verdict_cjs_1 = require("./gate-verdict.cjs");
const gate_evidence_cjs_1 = require("./gate-evidence.cjs");
const gate_config_cjs_1 = require("./gate-config.cjs");
const runtime_slash_cjs_1 = require("./runtime-slash.cjs");
const gate_phase_context_cjs_1 = require("./gate-phase-context.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
const planningWorkspace = require("./planning-workspace.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
const verificationMod = require("./verification.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
const phaseIdMod = require("./phase-id.cjs");
const { scopeToPhase } = phaseIdMod;
const { planningDir, isPhaseSpecFile, findPhaseSpecIn } = planningWorkspace;
const { defaultPhaseCleanCommitTimesMs } = verificationMod;
/**
 * Pure comparator: which of `entries` have an effective last-changed time
 * STRICTLY BEFORE `contextEffectiveMs` (CONTEXT.md's own effective time)? Strict
 * `<` is "stale" (matches findStaleVerificationSummary's own strict `>` convention
 * for "newer than" elsewhere in this codebase — an artifact committed in the SAME
 * commit/second as CONTEXT.md is in sync, not stale).
 */
function computeContextDrift(contextEffectiveMs, entries) {
    return entries.filter((e) => e.effectiveMs < contextEffectiveMs).map((e) => e.file);
}
function buildContextDriftMessage(staleArtifacts, phaseArg, projectDir) {
    const parts = [`CONTEXT.md decisions are newer than: ${staleArtifacts.join(', ')}.`];
    if (staleArtifacts.some((f) => f.endsWith('-RESEARCH.md'))) {
        parts.push(`Regenerate research: ${(0, runtime_slash_cjs_1.runtimeCommand)(projectDir, `plan-phase ${phaseArg} --research`)}.`);
    }
    if (staleArtifacts.some((f) => f.endsWith('-PATTERNS.md'))) {
        parts.push(`Regenerate patterns: delete the PATTERNS.md file, then re-run ${(0, runtime_slash_cjs_1.runtimeCommand)(projectDir, 'plan-phase')}.`);
    }
    if (staleArtifacts.some((f) => f.endsWith('-VALIDATION.md') || isPhaseSpecFile(f))) {
        parts.push('Regenerate or manually reconcile VALIDATION.md / SPEC.md against the current decisions.');
    }
    parts.push('Do not hand-inject the newer decisions into a prompt as a substitute for regenerating — that carries the staleness forward.');
    return parts.join(' ');
}
/** The non-blocking context-drift payload for an arm that did not compare artifacts: `skip` or `unreadable`. */
function contextDriftPayload(build, reason, message = '') {
    return build(false, { block: false, skipped: true, reason, stale_artifacts: [], message });
}
function runContextDriftGate(cwd, phaseArg) {
    const pDir = planningDir(cwd);
    const phasesDir = node_path_1.default.join(pDir, 'phases');
    // `none`: a documented "nothing to compare" (no CONTEXT.md, no upstream artifact).
    const skip = (reason, message = '') => contextDriftPayload((block, payload) => (0, gate_verdict_cjs_1.gateVerdict)('skip', block, payload), reason, message);
    // An unresolvable phase is "could not look" (#5170): there is no phase directory to compare.
    const unresolvable = () => contextDriftPayload(gate_verdict_cjs_1.gateUnreadable, 'phase-not-found', `Phase directory not found: ${phaseArg}`);
    // The same policy as `verify schema-drift`: an ABSENT phases tree is `none` (the documented
    // "nothing to compare" skip); one that exists but cannot be examined is `unreadable`.
    const phasesRoot = (0, gate_evidence_cjs_1.statEvidence)(phasesDir);
    if (phasesRoot.kind === 'unreadable') {
        return contextDriftPayload(gate_verdict_cjs_1.gateUnreadable, 'phases-dir-unreadable', `Could not examine ${phasesDir} (${phasesRoot.reason})`);
    }
    if (phasesRoot.kind === 'none') {
        return skip('no-phases-directory', 'No phases directory');
    }
    // Same phase-directory resolution rule the schema-drift gate uses (#1571, #2528):
    // matchPhaseDirs, never a naive substring test.
    const phaseDir = (0, gate_phase_context_cjs_1.resolvePhaseDirByToken)(cwd, phasesDir, phaseArg);
    if (!phaseDir) {
        return unresolvable();
    }
    const phaseEntries = (0, gate_evidence_cjs_1.readDirEvidence)(phaseDir);
    if (phaseEntries.kind !== 'found') {
        return unresolvable();
    }
    const phaseFiles = phaseEntries.value.slice().sort();
    const contextFile = phaseFiles.find((f) => f.endsWith('-CONTEXT.md'));
    if (!contextFile) {
        return skip('no-context-md');
    }
    const researchFile = phaseFiles.find((f) => f.endsWith('-RESEARCH.md'));
    const patternsFile = phaseFiles.find((f) => f.endsWith('-PATTERNS.md'));
    const validationFile = phaseFiles.find((f) => f.endsWith('-VALIDATION.md'));
    // #5629: the shared phase-SPEC predicate (the init payloads' `has_spec` / `spec_path` use the same one).
    // Scoped to this phase's own artifacts, as init scopes it, so a misfiled `02-SPEC.md` agrees in both.
    const specFile = findPhaseSpecIn(scopeToPhase(phaseFiles, node_path_1.default.basename(phaseDir)));
    const upstreamFiles = [researchFile, patternsFile, validationFile, specFile].filter((f) => !!f);
    if (upstreamFiles.length === 0) {
        return skip('no-upstream-artifacts');
    }
    const allFiles = [contextFile, ...upstreamFiles];
    const cleanCommitMs = defaultPhaseCleanCommitTimesMs(phaseDir, allFiles);
    const effectiveTimeMs = (file) => cleanCommitMs.has(file)
        ? cleanCommitMs.get(file)
        : node_fs_1.default.statSync(node_path_1.default.join(phaseDir, file)).mtimeMs;
    const contextMs = effectiveTimeMs(contextFile);
    const driftEntries = upstreamFiles.map((f) => ({ file: f, effectiveMs: effectiveTimeMs(f) }));
    const staleArtifacts = computeContextDrift(contextMs, driftEntries);
    // Through the quiet gate-config reader (workstream config first, then the project root's; a
    // missing or malformed config is "key absent", nothing is printed).
    const action = (0, gate_config_cjs_1.readWorkflowConfigValue)(cwd, 'workflow.context_drift_action').value === 'block' ? 'block' : 'warn';
    const block = staleArtifacts.length > 0 && action === 'block';
    const message = staleArtifacts.length > 0 ? buildContextDriftMessage(staleArtifacts, phaseArg, cwd) : '';
    return (0, gate_verdict_cjs_1.gateVerdict)(block ? 'block' : (staleArtifacts.length > 0 ? 'advisory' : 'pass'), block, {
        block,
        skipped: false,
        stale_artifacts: staleArtifacts,
        action,
        message,
    });
}
function evaluateContextDriftGate(input) {
    const phaseArg = input.args[0] || '';
    if (!phaseArg) {
        // UNKNOWN: the pre-move `error('Usage…')` named no reason, and the reason is observable (#5219).
        return (0, gate_verdict_cjs_1.gateUsageFailure)(gate_verdict_cjs_1.GATE_FAILURE_CODE.UNKNOWN, 'Usage: verify context-drift <phase>');
    }
    // Non-blocking contract: a throw anywhere (an invalid GSD_WORKSTREAM, an unreadable file)
    // yields the non-blocking payload; the exit status says "could not look" (#5170) rather than
    // a clean exit 0.
    try {
        return runContextDriftGate(input.projectDir, phaseArg);
    }
    catch (err) {
        return contextDriftPayload(gate_verdict_cjs_1.gateUnreadable, 'exception: ' + (err instanceof Error ? err.message : String(err)));
    }
}
