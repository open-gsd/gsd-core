"use strict";
/**
 * STATE.md Transition Module — ADR-1769.
 *
 * Phase 1 substrate: field-classification table, section constants, the pure
 * `transitionCore` dispatch, and the `beginPhase` intent (migrating
 * `cmdStateBeginPhase` in state.cts onto this seam).
 *
 * Sibling/super-module of the STATE.md Document Module (state-document.cjs):
 * consumes its `stateExtractField` / `stateReplaceField` primitives. Body
 * section headings live as constants here (single writer after migration).
 *
 * Pure core + injected I/O (ADR-1769 §3): the exported `transitionCore` is a
 * pure function `(content, intent, deps) → result`; adapters that own locks,
 * file I/O, and the disk-scan wrap it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATE_MD_SECTIONS = exports.FIELD_CLASSIFICATION = void 0;
exports.getFieldClassification = getFieldClassification;
exports.transitionCore = transitionCore;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontmatter = require("./frontmatter.cjs");
const state_document_cjs_1 = require("./state-document.cjs");
const state_document_cjs_2 = require("./state-document.cjs");
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
const phase_lifecycle_cjs_1 = require("./phase-lifecycle.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseIdMod = require("./phase-id.cjs");
const { extractFrontmatter, reconstructFrontmatter } = frontmatter;
const { escapeRegex } = phaseIdMod;
// Stop predicate for section-body slicing: a level-2+ heading ends the section.
const STOP_H2_PLUS = (lv) => lv >= 2;
/**
 * Single source of truth for "which fields win when frontmatter and body
 * disagree". Transitions declare which body fields they touch; the core
 * consults the table to apply the preservation policy uniformly.
 *
 * Adding a new STATE.md field = one row here, not 9 transition edits.
 *
 * Field set verified against `buildStateFrontmatter` (state.cts:1474) — every
 * frontmatter key emitted there has a row here.
 *
 * Frozen null-prototype object: prevents prototype-pollution lookups
 * (`FIELD_CLASSIFICATION['toString']` returns undefined, not the inherited
 * function). Use `getFieldClassification()` for lookups.
 */
exports.FIELD_CLASSIFICATION = Object.freeze(Object.assign(Object.create(null), {
    // Schema
    gsd_state_version: { source: 'free', preservation: 'derive' },
    // Milestone (external — from ROADMAP.md)
    milestone: { source: 'external', preservation: 'preserve-if-placeholder' },
    milestone_name: { source: 'external', preservation: 'preserve-if-placeholder' },
    // Phase / plan position (body-derived)
    current_phase: { source: 'body', preservation: 'preserve-when-unchanged' },
    current_phase_name: { source: 'curated', preservation: 'preserve-always' }, // #1743, #1695
    current_plan: { source: 'body', preservation: 'preserve-when-unchanged' },
    // Status / lifecycle (body-derived; #1230 delta heuristic applies)
    status: { source: 'body', preservation: 'preserve-when-unchanged' },
    stopped_at: { source: 'body', preservation: 'preserve-when-unchanged' },
    paused_at: { source: 'body', preservation: 'preserve-when-unchanged' },
    // Activity log
    last_updated: { source: 'free', preservation: 'derive' }, // realClock.nowIso()
    last_activity: { source: 'body', preservation: 'derive' }, // always refresh on transition
    last_activity_desc: { source: 'body', preservation: 'preserve-when-unchanged' },
    // Progress block (disk-derived, except the curated progress ratchet)
    progress: { source: 'curated', preservation: 'preserve-always' }, // #3242, #1446
    'progress.total_phases': { source: 'disk', preservation: 'derive' },
    'progress.completed_phases': { source: 'disk', preservation: 'derive' },
    'progress.total_plans': { source: 'disk', preservation: 'derive' },
    'progress.completed_plans': { source: 'disk', preservation: 'derive' },
    'progress.percent': { source: 'disk', preservation: 'derive' },
}));
/**
 * Own-property classification lookup. Returns `null` for unknown fields
 * (including inherited prototype methods like `toString`/`valueOf`).
 */
function getFieldClassification(field) {
    if (!Object.prototype.hasOwnProperty.call(exports.FIELD_CLASSIFICATION, field))
        return null;
    return exports.FIELD_CLASSIFICATION[field];
}
// ----------------------------------------------------------------------------
// Body section constants (ADR-1769 §6 — single writer after migration)
// ----------------------------------------------------------------------------
/**
 * Top-level STATE.md section headings (H2). Aligned byte-for-byte with the
 * canonical template at `gsd-core/templates/state.md`. Sub-headings (H3) like
 * `### Decisions` / `### Pending Todos` / `### Blockers/Concerns` live under
 * `## Accumulated Context` and are not mutated by any Phase 1–7 transition;
 * they will be added here if a future transition needs them.
 *
 * Verified against `gsd-core/templates/state.md` (codex Phase 1 review).
 */
exports.STATE_MD_SECTIONS = {
    projectReference: '## Project Reference',
    currentPosition: '## Current Position',
    performanceMetrics: '## Performance Metrics',
    accumulatedContext: '## Accumulated Context',
    deferredItems: '## Deferred Items',
    sessionContinuity: '## Session Continuity',
};
// ----------------------------------------------------------------------------
// transitionCore — pure dispatch (ADR-1769 §3)
// ----------------------------------------------------------------------------
/**
 * Pure transition core. `(content, intent, deps) → result`.
 *
 * Discriminated-union dispatch via plain `switch` (ADR-1769 §2.7 Kernighan's
 * Law: debuggability over conciseness; the substrate sets the pattern).
 *
 * Phases 2–7 add cases for the remaining 9 intent kinds. A missing case is
 * a compile-time error (the function would not return on that path).
 */
function transitionCore(content, intent, deps) {
    switch (intent.kind) {
        case 'beginPhase':
            return beginPhaseCore(content, intent, deps);
        case 'advancePlan':
            return advancePlanCore(content, deps);
        case 'completePhase':
            return completePhaseCore(content, intent, deps);
    }
}
// ----------------------------------------------------------------------------
// beginPhase — intent implementation (Phase 1)
// ----------------------------------------------------------------------------
/**
 * Apply a `beginPhase` transition to STATE.md content.
 *
 * Phase 1 scope (this file): the Status field update only. Subsequent
 * behaviors land via RED-GREEN cycles per the ADR-1769 migration plan:
 *   - Current Phase, Current Phase Name, Current Plan, Total Plans
 *   - Current Position section mutation
 *   - Idempotency guard (#3127)
 *   - Resume vs first-time branching
 *   - #1255 / #1257 format-detection parity
 *
 * Adapters that acquire the STATE.md lock and call this core live in
 * state.cts and consume the existing `readModifyWriteStateMd` post-sync
 * machinery (preserves the #1230 delta heuristic without re-implementing it).
 */
function beginPhaseCore(content, intent, deps) {
    const updated = [];
    // #1255: body-field replacements operate on body only (frontmatter stripped),
    // not on the full content. The YAML `status:` key matches `^Status:\s*`
    // before the body pipe-table row if full content is passed.
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    const today = deps.clock.today();
    // Consult the field-classification table for the frontmatter keys this
    // transition touches (codex Phase 1 review: "table not consulted by
    // transitionCore"). The table tracks FRONTMATTER keys (lowercase: `status`,
    // `current_phase`, `last_activity`); body field names like `Status` /
    // `Current Phase` are aliases and aren't enforced here — they're driven by
    // the first-time/resume branching below, which encodes the same rules.
    // Phase 2+ will dispatch preservation based on this lookup.
    for (const fmKey of ['status', 'current_phase', 'current_plan', 'last_activity']) {
        const cls = getFieldClassification(fmKey);
        if (cls === null) {
            throw new Error(`transitionCore beginPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
                `add a row per ADR-1769 §4 before touching it.`);
        }
    }
    // Helper: try to replace a body field; push to `updated` on success.
    // Body field names (Title Case: 'Status', 'Current Phase') are not in the
    // table — they're body-side aliases of classified frontmatter keys.
    const tryField = (name, value) => {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(body, name, value);
        if (replaced !== null) {
            body = replaced;
            updated.push(name);
        }
    };
    // #3127 idempotency guard: if Status already contains "Executing Phase N" for
    // the current phase number, this is a resume (e.g. --wave N continue). Skip
    // the first-time-only fields so mid-flight state (Current Plan, Total Plans,
    // Current Phase Name, Last Activity Description) is preserved.
    // Extract from body (not full content) so the YAML `status:` key cannot
    // shadow the body Status field (#1255).
    const currentStatus = (0, state_document_cjs_1.stateExtractField)(body, 'Status') || '';
    const isAlreadyExecuting = new RegExp(`Executing Phase\\s+${escapeRegex(String(intent.phaseNumber))}\\b`, 'i').test(currentStatus);
    // Status update (applies on both first-time and resume — Status is always refreshed).
    tryField('Status', `Executing Phase ${intent.phaseNumber}`);
    // Last Activity date — safe to refresh on resume (tracks when execute-phase ran).
    tryField('Last Activity', today);
    if (!isAlreadyExecuting) {
        // First-time execution: set all progress fields.
        tryField('Last Activity Description', `Phase ${intent.phaseNumber} execution started`);
        tryField('Current Phase', String(intent.phaseNumber));
        if (intent.phaseName) {
            tryField('Current Phase Name', intent.phaseName);
        }
        tryField('Current Plan', '1');
        if (intent.planCount) {
            tryField('Total Plans in Phase', String(intent.planCount));
        }
        // **Current focus:** body text line (#1104).
        const focusLabel = intent.phaseName
            ? `Phase ${intent.phaseNumber} — ${intent.phaseName}`
            : `Phase ${intent.phaseNumber}`;
        const focusPattern = /(\*\*Current focus:\*\*\s*).*/i;
        if (focusPattern.test(body)) {
            body = body.replace(focusPattern, (_match, prefix) => `${prefix}${focusLabel}`);
            updated.push('Current focus');
        }
        // ## Current Position section mutation (#1104, #1365).
        // ADR-1372 T6: tokenizeHeadings + offset splicing (replaceSection adoption
        // deferred to a later phase). Mirrors state.cts:2261-2324 byte-for-behaviour.
        body = mutateCurrentPositionFirstTime(body, intent, today, updated);
    }
    else {
        // Resume path: only update Last activity timestamp in Current Position
        // (do not touch Plan:, Phase:, Status:, stopped_at, progress.percent).
        body = mutateCurrentPositionResume(body, intent, today, updated);
    }
    return { content: reassemble(body), updated };
}
/**
 * Find the `## Current Position` section, return its `{start, end}` byte
 * offsets in `body` (end is exclusive — first byte of the next section or
 * body.length). Returns `null` when the section is absent.
 *
 * ADR-1372 T6: tokenizeHeadings-based locator (fence-aware).
 */
function locateCurrentPosition(body) {
    const hs = (0, markdown_sectionizer_cjs_1.tokenizeHeadings)(body);
    const idx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
    if (idx === -1)
        return null;
    const h = hs[idx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const start = h.offset + hl.length + 1;
    let end = body.length;
    for (let j = idx + 1; j < hs.length; j++) {
        if (STOP_H2_PLUS(hs[j].level)) {
            end = hs[j].offset - 1;
            break;
        }
    }
    return { start, end };
}
/**
 * First-time ## Current Position mutation: update Phase / Plan / Status /
 * Last activity lines. Mirrors state.cts:2261-2324 byte-for-behaviour
 * (inline regex first, pipe-table fallback via stateReplaceField — #1257).
 */
function mutateCurrentPositionFirstTime(body, intent, today, updated) {
    const span = locateCurrentPosition(body);
    if (span === null)
        return body;
    let sectionBody = body.slice(span.start, span.end);
    // Phase line — inline first, then pipe-table fallback (#1257).
    const phaseLabel = `${intent.phaseNumber}${intent.phaseName ? ` (${intent.phaseName})` : ''} — EXECUTING`;
    if (/^Phase:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${phaseLabel}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Phase', phaseLabel);
        if (replaced !== null)
            sectionBody = replaced;
    }
    // Plan line.
    const planValue = `1 of ${intent.planCount || '?'}`;
    if (/^Plan:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${planValue}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Plan', planValue);
        if (replaced !== null)
            sectionBody = replaced;
    }
    // Status line.
    const statusValue = `Executing Phase ${intent.phaseNumber}`;
    if (/^Status:/m.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Status:.*$/m, `Status: ${statusValue}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Status', statusValue);
        if (replaced !== null)
            sectionBody = replaced;
    }
    // Last activity line. The inline value carries date + narrative.
    const activityValue = `${today} — Phase ${intent.phaseNumber} execution started`;
    if (/^Last activity:/im.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Last activity:.*$/im, `Last activity: ${activityValue}`);
    }
    else {
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last Activity', activityValue) ??
            (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last activity', activityValue);
        if (replaced !== null)
            sectionBody = replaced;
    }
    updated.push('Current Position');
    return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}
/**
 * Resume ## Current Position mutation: only update Last activity line
 * (preserves Plan/Phase/Status — #3127). Mirrors state.cts:2329-2363
 * byte-for-behaviour.
 */
function mutateCurrentPositionResume(body, intent, today, updated) {
    const span = locateCurrentPosition(body);
    if (span === null)
        return body;
    let sectionBody = body.slice(span.start, span.end);
    const resumeActivity = `Last activity: ${today} — Phase ${intent.phaseNumber} execution resumed (wave continue)`;
    if (/^Last activity:/im.test(sectionBody)) {
        sectionBody = sectionBody.replace(/^Last activity:.*$/im, resumeActivity);
        updated.push('Last activity (resume)');
    }
    else {
        // Pipe-table format fallback (#1255).
        const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last Activity', resumeActivity) ??
            (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Last activity', resumeActivity);
        if (replaced !== null) {
            sectionBody = replaced;
            updated.push('Last activity (resume)');
        }
    }
    return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}
/**
 * Strip ALL frontmatter blocks from the start of `content`.
 *
 * TODO (ADR-1769 follow-up): move to `frontmatter.cjs` or `state-document.cjs`
 * so it's a shared primitive. Inlined here in Phase 1 to avoid touching
 * `state.cjs` (which is the migration target itself) and to keep the Phase 1
 * diff contained. Body is byte-identical to `state.cts:1653 stripFrontmatter`
 * (same CRLF + stacked-block handling).
 */
function stripFrontmatter(content) {
    let result = content;
    while (true) {
        const stripped = result.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*/, '');
        if (stripped === result)
            break;
        result = stripped;
    }
    return result;
}
/**
 * Update fields within the ## Current Position section for advancePlan.
 * Mirrors `updateCurrentPositionFields` (state.cts:496) byte-for-behaviour:
 * only replaces Status / Last Activity when the existing value is a known
 * template default (Knuth invariant: preserve executor-authored values).
 * Plan is always replaced (system-derived, never executor-authored).
 *
 * Cannot import `updateCurrentPositionFields` from state.cjs directly (circular
 * dep: state.cjs → state-transition.cjs → state.cjs), so the mutation is
 * inlined here using the same primitives.
 */
function mutateCurrentPositionForAdvance(content, fields, statusDefaults, lastActivityDefaults) {
    const span = locateCurrentPosition(content);
    if (span === null)
        return content;
    let sectionBody = content.slice(span.start, span.end);
    let mutated = false;
    if (fields.status) {
        const replaced = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(sectionBody, 'Status', statusDefaults, fields.status);
        if (replaced !== null && replaced !== sectionBody) {
            sectionBody = replaced;
            mutated = true;
        }
    }
    if (fields.lastActivity) {
        const replaced = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(sectionBody, 'Last Activity', lastActivityDefaults, fields.lastActivity) ??
            (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(sectionBody, 'Last activity', lastActivityDefaults, fields.lastActivity);
        if (replaced !== null && replaced !== sectionBody) {
            sectionBody = replaced;
            mutated = true;
        }
    }
    if (fields.plan) {
        // Plan is always replaced — system-derived, not executor-authored.
        if (/^Plan:/m.test(sectionBody)) {
            sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${fields.plan}`);
            mutated = true;
        }
        else {
            const replaced = (0, state_document_cjs_1.stateReplaceField)(sectionBody, 'Plan', fields.plan);
            if (replaced !== null) {
                sectionBody = replaced;
                mutated = true;
            }
        }
    }
    if (!mutated)
        return content;
    return content.slice(0, span.start) + sectionBody + content.slice(span.end);
}
// ----------------------------------------------------------------------------
// advancePlan — intent implementation (Phase 2)
// ----------------------------------------------------------------------------
/**
 * Apply an `advancePlan` transition to STATE.md content.
 *
 * Parses Current Plan / Total Plans (legacy separate fields or compound
 * "Plan: X of Y" format), increments the plan number, updates body fields
 * and the ## Current Position section. When currentPlan >= totalPlans,
 * takes the phase-complete branch (sets Status to "Phase complete — ready
 * for verification") instead of advancing.
 *
 * Uses `stateReplaceFieldIfTemplate` (template-default-aware) to preserve
 * executor-authored field values (Knuth invariant from cmdStateAdvancePlan).
 *
 * Returns `data.advanced` / `data.currentPlan` / `data.totalPlans` for the
 * adapter to construct CLI output.
 */
function advancePlanCore(content, deps) {
    const today = deps.clock.today();
    // #1255: body-field replacements operate on body only (frontmatter stripped),
    // not on the full content. The YAML `status:` key matches `^Status:\s*`
    // before the body field if full content is passed (codex Phase 2 review:
    // HIGH blocking finding — same pattern beginPhaseCore already handles).
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    // Parse plan number — legacy first, then compound.
    const legacyPlan = (0, state_document_cjs_1.stateExtractField)(content, 'Current Plan');
    const legacyTotal = (0, state_document_cjs_1.stateExtractField)(content, 'Total Plans in Phase');
    const planField = (0, state_document_cjs_1.stateExtractField)(content, 'Plan');
    let currentPlan;
    let totalPlans;
    let useCompoundFormat = false;
    if (legacyPlan && legacyTotal) {
        currentPlan = parseInt(legacyPlan, 10);
        totalPlans = parseInt(legacyTotal, 10);
    }
    else if (planField) {
        currentPlan = parseInt(planField, 10);
        const ofMatch = planField.match(/of\s+(\d+)/);
        totalPlans = ofMatch ? parseInt(ofMatch[1], 10) : NaN;
        useCompoundFormat = true;
    }
    else {
        currentPlan = NaN;
        totalPlans = NaN;
    }
    if (isNaN(currentPlan) || isNaN(totalPlans)) {
        return { content: reassemble(body), updated: [], data: { error: true } };
    }
    const updated = [];
    const statusDefaults = state_document_cjs_2.KNOWN_TEMPLATE_DEFAULTS['Status'];
    const lastActivityDefaults = state_document_cjs_2.KNOWN_TEMPLATE_DEFAULTS['Last Activity'];
    if (currentPlan >= totalPlans) {
        // Phase-complete branch.
        body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Status', statusDefaults, 'Phase complete — ready for verification') || body;
        body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last Activity', lastActivityDefaults, today) || body;
        body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last activity', lastActivityDefaults, today) || body;
        body = mutateCurrentPositionForAdvance(body, {
            status: 'Phase complete — ready for verification',
            lastActivity: today,
        }, statusDefaults, lastActivityDefaults);
        updated.push('Status', 'Last Activity', 'Current Position');
        return {
            content: reassemble(body),
            updated,
            data: { advanced: false, reason: 'last_plan', current_plan: currentPlan, total_plans: totalPlans, status: 'ready_for_verification' },
        };
    }
    // Normal advance branch.
    const newPlan = currentPlan + 1;
    let planDisplayValue;
    if (useCompoundFormat) {
        planDisplayValue = planField.replace(/^\d+/, String(newPlan));
        body = (0, state_document_cjs_1.stateReplaceField)(body, 'Plan', planDisplayValue) || body;
    }
    else {
        planDisplayValue = `${newPlan} of ${totalPlans}`;
        body = (0, state_document_cjs_1.stateReplaceField)(body, 'Current Plan', String(newPlan)) || body;
    }
    body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Status', statusDefaults, 'Ready to execute') || body;
    body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last Activity', lastActivityDefaults, today) || body;
    body = (0, state_document_cjs_1.stateReplaceFieldIfTemplate)(body, 'Last activity', lastActivityDefaults, today) || body;
    body = mutateCurrentPositionForAdvance(body, {
        status: 'Ready to execute',
        lastActivity: today,
        plan: planDisplayValue,
    }, statusDefaults, lastActivityDefaults);
    updated.push('Current Plan', 'Status', 'Last Activity', 'Current Position');
    return {
        content: reassemble(body),
        updated,
        data: { advanced: true, previous_plan: currentPlan, current_plan: newPlan, total_plans: totalPlans },
    };
}
// ----------------------------------------------------------------------------
// completePhase — intent implementation (Phase 3)
// ----------------------------------------------------------------------------
/**
 * Apply a `completePhase` transition to STATE.md content.
 *
 * Migrates the inline STATE.md transform that lived inside `cmdPhaseComplete`
 * (phase.cts) onto the substrate. Owns the field-classification-governed body
 * mutations: Current Phase (preserving the `of total` shape and phase name),
 * Current Phase Name, Status (`Milestone complete` on the last phase, else
 * `Ready to plan`), Current Plan (`Not started`), Last Activity + Description,
 * and the Completed/Total Phases + Progress percent block (re-derived from the
 * roadmap via the injected `roadmapProvider`).
 *
 * The adapter (`cmdPhaseComplete`) retains two concerns that are NOT pure field
 * updates: `updatePerformanceMetricsSection` (a section table upsert) and
 * `syncStateFrontmatter` (the disk-scan post-sync). It also retains the
 * multi-file atomic transaction (`writePlanningFileSet`) that writes ROADMAP,
 * REQUIREMENTS, and STATE together — `readModifyWriteStateMd` is not used here
 * because STATE.md is committed atomically with the other two files.
 *
 * Behavior is byte-for-byte with the pre-migration `phase.cts:1671-1772` block
 * (verified by characterization tests in tests/state-transition.test.cjs).
 */
function completePhaseCore(content, intent, deps) {
    const updated = [];
    const today = deps.clock.today();
    // Consult the field-classification table for the frontmatter keys this
    // transition touches (same guard beginPhaseCore applies). A missing row is a
    // substrate defect — fail loudly rather than silently re-encoding policy.
    for (const fmKey of [
        'current_phase',
        'current_phase_name',
        'status',
        'current_plan',
        'last_activity',
        'last_activity_desc',
        'progress',
    ]) {
        const cls = getFieldClassification(fmKey);
        if (cls === null) {
            throw new Error(`transitionCore completePhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
                `add a row per ADR-1769 §4 before touching it.`);
        }
    }
    // #1255: body-field replacements operate on body only (frontmatter stripped),
    // so the YAML `status:` / `current_phase:` keys cannot shadow the body fields.
    const existingFm = extractFrontmatter(content);
    const hasFrontmatter = Object.keys(existingFm).length > 0;
    let body = stripFrontmatter(content);
    const reassemble = (b) => hasFrontmatter
        ? `---\n${reconstructFrontmatter(existingFm)}\n---\n\n${b}`
        : b;
    // Current Phase — preserve the existing `of <total>` shape and the phase name
    // in parens (mirrors phase.cts:1675-1697 byte-for-behaviour).
    const phaseValue = intent.nextPhaseNum || intent.phaseNum;
    const nextPhaseDisplayName = intent.nextPhaseName;
    const existingPhaseField = (0, state_document_cjs_1.stateExtractField)(body, 'Current Phase') || (0, state_document_cjs_1.stateExtractField)(body, 'Phase');
    let newPhaseValue = String(phaseValue);
    if (existingPhaseField) {
        const totalMatch = existingPhaseField.match(/of\s+(\d+)/);
        const nameMatch = existingPhaseField.match(/\(([^)]+)\)/);
        if (totalMatch) {
            const total = totalMatch[1];
            const nameStr = nextPhaseDisplayName
                ? ` (${nextPhaseDisplayName})`
                : nameMatch
                    ? ` (${nameMatch[1]})`
                    : '';
            newPhaseValue = `${phaseValue} of ${total}${nameStr}`;
        }
        else if (nextPhaseDisplayName) {
            newPhaseValue = `${phaseValue} — ${nextPhaseDisplayName}`;
        }
    }
    const phaseAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Current Phase', 'Phase', newPhaseValue);
    if (phaseAfter !== body) {
        body = phaseAfter;
        updated.push('Current Phase');
    }
    // Current Phase Name — only written when a next-phase display name is known
    // (#1743/#1695: classified curated/preserve-always, so an absent name does
    // NOT clear an existing curated value).
    if (nextPhaseDisplayName) {
        const after = (0, state_document_cjs_1.stateReplaceField)(body, 'Current Phase Name', nextPhaseDisplayName);
        if (after) {
            body = after;
            updated.push('Current Phase Name');
        }
    }
    // Status — `Milestone complete` on the final phase, otherwise `Ready to plan`.
    const statusValue = intent.isLastPhase ? 'Milestone complete' : 'Ready to plan';
    const statusAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Status', null, statusValue);
    if (statusAfter !== body) {
        body = statusAfter;
        updated.push('Status');
    }
    // Current Plan — reset for the next phase.
    const planAfter = (0, state_document_cjs_1.stateReplaceFieldWithFallback)(body, 'Current Plan', 'Plan', 'Not started');
    if (planAfter !== body) {
        body = planAfter;
        updated.push('Current Plan');
    }
    // Last Activity — prefer the prose `Last activity:` line (date + narrative)
    // when present, else the bold `Last Activity:` date field.
    const lastActivityDescription = `Phase ${intent.phaseNum} complete${intent.nextPhaseNum ? `, transitioned to Phase ${intent.nextPhaseNum}` : ''}`;
    if (/^Last activity:/m.test(body)) {
        const after = (0, state_document_cjs_1.stateReplaceField)(body, 'Last activity', `${today} — ${lastActivityDescription}`);
        if (after) {
            body = after;
            updated.push('Last Activity');
        }
    }
    else {
        const after = (0, state_document_cjs_1.stateReplaceField)(body, 'Last Activity', today);
        if (after) {
            body = after;
            updated.push('Last Activity');
        }
    }
    const ladAfter = (0, state_document_cjs_1.stateReplaceField)(body, 'Last Activity Description', lastActivityDescription);
    if (ladAfter) {
        body = ladAfter;
        updated.push('Last Activity Description');
    }
    // Progress block — re-derive completed/total phases from the roadmap when
    // available (milestone-wide source of truth), then recompute the percent.
    // Only runs when a Completed Phases field exists (the existing guard).
    const completedRaw = (0, state_document_cjs_1.stateExtractField)(body, 'Completed Phases');
    if (completedRaw !== null) {
        let newCompleted = parseInt(completedRaw, 10);
        let derivedTotalPhases = null;
        const roadmapContent = deps.roadmapProvider ? deps.roadmapProvider() : null;
        if (roadmapContent) {
            const derived = (0, phase_lifecycle_cjs_1.deriveProgressFromRoadmap)(roadmapContent);
            if (derived.completedPhases !== null)
                newCompleted = derived.completedPhases;
            if (derived.totalPhases !== null)
                derivedTotalPhases = derived.totalPhases;
        }
        const completedAfter = (0, state_document_cjs_1.stateReplaceField)(body, 'Completed Phases', String(newCompleted));
        if (completedAfter) {
            body = completedAfter;
            updated.push('Completed Phases');
        }
        const totalRaw = (0, state_document_cjs_1.stateExtractField)(body, 'Total Phases');
        const totalPhases = derivedTotalPhases || (totalRaw ? parseInt(totalRaw, 10) : null);
        if (totalPhases && totalPhases > 0) {
            const newPercent = (0, phase_lifecycle_cjs_1.clampPercent)(newCompleted, totalPhases);
            const progAfter = (0, state_document_cjs_1.stateReplaceField)(body, 'Progress', `${newPercent}%`);
            if (progAfter) {
                body = progAfter;
                updated.push('Progress');
            }
            // Inline `percent:` token (frontmatter / progress sub-block).
            body = body.replace(/(percent:\s*)\d+/, `$1${newPercent}`);
        }
    }
    return { content: reassemble(body), updated };
}
