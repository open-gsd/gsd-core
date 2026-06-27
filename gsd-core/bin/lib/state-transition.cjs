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
exports.transitionCore = transitionCore;
const frontmatter = require("./frontmatter.cjs");
const state_document_cjs_1 = require("./state-document.cjs");
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
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
 */
exports.FIELD_CLASSIFICATION = {
    // Frontmatter keys (the derived side)
    status: 'derived-from-body',
    current_phase: 'derived-from-body',
    current_phase_name: 'curated', // #1743, #1695 impossible-by-construction
    current_plan: 'derived-from-body',
    total_phases: 'derived-from-disk',
    total_plans: 'derived-from-disk',
    completed_phases: 'derived-from-disk',
    completed_plans: 'derived-from-disk',
    percent: 'derived-from-disk',
    milestone: 'derived-from-external',
    milestone_name: 'derived-from-external',
    last_activity: 'derived-from-body',
    stopped_at: 'derived-from-body',
    paused_at: 'derived-from-body',
    progress: 'curated', // curated-progress ratchet (#3242, #1446)
};
// ----------------------------------------------------------------------------
// Body section constants (ADR-1769 §6 — single writer after migration)
// ----------------------------------------------------------------------------
/**
 * The set of body section headings the Transition Module may mutate.
 * Inline literals are forbidden outside this constants block.
 */
exports.STATE_MD_SECTIONS = {
    currentPosition: '## Current Position',
    session: '## Session',
    decisions: '## Decisions',
    operatorNextSteps: '## Operator Next Steps',
    performanceMetrics: '## Performance Metrics',
    sessionLog: '## Session Log',
    projectReference: '## Project Reference',
    roadmapEvolution: '## Roadmap Evolution',
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
    // Helper: try to replace a body field; push to `updated` on success.
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
