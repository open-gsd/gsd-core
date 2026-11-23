"use strict";
/**
 * Health Diagnostic Types — shared, dependency-free rule-table types (Phase
 * 11, #3309, ADR-3180 §8.2/§8.3/§8.5).
 *
 * Split out from `src/health-diagnostic.cts` to break a CJS circular
 * dependency between the evaluator and its own rule-group files
 * (`src/health-diagnostic-rules/*.cts`): those files need the frozen
 * `SEVERITY`/`REMEDY_ACTION`/`REMEDY_RISK` enums and the `Diagnostic`/
 * `Remedy`/`Rule` shapes, but the evaluator (`health-diagnostic.cts`) also
 * needs to `require()` every rule-group file to populate its `RULES` array —
 * a rule-group file requiring `health-diagnostic.cjs` back, mid-load, reads
 * `module.exports` before it is assigned, so the destructured enums come
 * back `undefined`. This leaf has NO runtime dependency on anything in that
 * cycle, so both sides can depend on it directly.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 * Test matrix: .gsd/phase/refactor-3309-health-diagnostic-rule-table/50-test-matrix.md
 *
 * ADR-457 build-at-publish: source in src/health-diagnostic-types.cts,
 * compiled to gsd-core/bin/lib/health-diagnostic-types.cjs (gitignored).
 */
// ─── Severity ───────────────────────────────────────────────────────────────
const SEVERITY = Object.freeze({
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info',
});
// ─── Remedy action / risk ───────────────────────────────────────────────────
// Harvested from health.md's published table + the corrected 6-action
// implementation (`src/verify.cts:2405-2553`) — not 5; `addAiIntegrationPhaseKey`
// (verify.cts:1860/2481-2502) was live in code, missing from docs (design
// doc, "Ground truth vs. issue #3309's claims" section).
const REMEDY_ACTION = Object.freeze({
    CREATE_CONFIG: 'createConfig',
    RESET_CONFIG: 'resetConfig',
    REGENERATE_STATE: 'regenerateState',
    ADD_NYQUIST_KEY: 'addNyquistKey',
    ADD_AI_INTEGRATION_PHASE_KEY: 'addAiIntegrationPhaseKey',
    BACKFILL_MILESTONES: 'backfillMilestones',
    // #5291: rewrite a KNOWN legacy verification `status` (W030) to its closed-set
    // equivalent, keeping the original in `legacy_status`. Per-finding: only
    // emitted when the raw value has a mapping; every other W030 stays ADVISE.
    REPAIR_VERIFICATION_STATUS: 'repairVerificationStatus',
    // §8.3 rule 5 — every non-repairable finding's `fix` string becomes an
    // ADVISE payload; ADVISE never acts, only describes.
    ADVISE: 'advise',
});
const REMEDY_RISK = Object.freeze({
    NONE: 'none',
    DESTRUCTIVE: 'destructive',
});
// ─── adviseRemedy — shared ADVISE-remedy builder ───────────────────────────
/**
 * Every rule-group file needs the same `{action: ADVISE, risk: NONE, args:
 * {command}}` shape for a non-repairable finding's `fix` string (§8.3 rule
 * 5). Was defined identically in `config-validation.cts` and
 * `agent-install.cts`, and repeated inline elsewhere — moved to this shared,
 * dependency-free leaf so every rule-group file imports one implementation
 * instead of duplicating it.
 */
function adviseRemedy(command) {
    return { action: REMEDY_ACTION.ADVISE, risk: REMEDY_RISK.NONE, args: { command } };
}
// ─── Exports ────────────────────────────────────────────────────────────────
const healthDiagnosticTypes = {
    SEVERITY,
    REMEDY_ACTION,
    REMEDY_RISK,
    adviseRemedy,
};
module.exports = healthDiagnosticTypes;
