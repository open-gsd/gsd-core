"use strict";
/**
 * Phase Status Module — the single owner of "what state is phase P in?"
 * (ADR-5057 §1/§2, epic #5056 Phase 1, #5060).
 *
 * ADR-3180 §7.4 made `isPhaseComplete` the owner of "is phase P complete?".
 * The richer question the UI, the health rules and the ROADMAP writers ask —
 * which rung of the lifecycle is this phase on — had no owner: it was derived
 * at eleven sites in seven vocabularies, and two of them disagreed on a stale
 * `passed` report. This module is that owner.
 *
 *   - `PHASE_STATUS` is a closed, frozen ladder. Its values are the upper-case
 *     rung names, spelled unlike every projection word, so a display label or
 *     a wire value can never pass for a status.
 *   - `phaseStatusFromFacts` is the ladder itself — pure. Callers that already
 *     hold the §7 owners' answers (the health rules over `PlanningSnapshot`,
 *     the pure Workstream Inventory builder, `update-plan-progress`'s stricter
 *     write gate) hand it those facts.
 *   - `phaseStatus(phaseDir)` gathers the facts from the §7 owners only —
 *     `scanPhasePlans` (§7.5) for counts and `isPhaseComplete` (§7.4) for
 *     completion and the verification verdict. It never reads VERIFICATION.md
 *     frontmatter itself.
 *   - Every other vocabulary is a projection exported here: display labels,
 *     the `state.json` / Workstream Inventory wire values, the ROADMAP
 *     `## Progress` Status cell (both directions), `roadmap analyze` /
 *     `init manager`'s `disk_status`, `init`'s `completion_status`, and
 *     `init progress`'s `status`. A consumer never maps raw inputs to a word.
 *   - Every function that takes a `PhaseStatus` throws `TypeError` on a value
 *     outside the ladder, so an out-of-vocabulary value fails where it is
 *     produced (ADR-5057 §1.2).
 *
 * LOAD-TIME LEAF. `verification.cjs` and `plan-scan.cjs` are required lazily
 * inside `phaseStatus()`. `state-contract.cjs` imports this module at top
 * level for its wire vocabulary, and `state-contract` sits on the documented
 * `state -> state-contract -> smart-entry -> state` require cycle; keeping this
 * module import-free at load keeps it off that cycle.
 *
 * ADR-457 build-at-publish: source in src/phase-status.cts, compiled to
 * gsd-core/bin/lib/phase-status.cjs (gitignored).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPLETION_STATUS = exports.PROGRESS_STATUS = exports.DISK_STATUS = exports.ROADMAP_STATUS_TOKEN = exports.WIRE_STATUS = exports.PHASE_STATUS = void 0;
exports.phaseStatusFromFacts = phaseStatusFromFacts;
exports.phaseStatus = phaseStatus;
exports.foldPhaseStatuses = foldPhaseStatuses;
exports.toDisplayLabel = toDisplayLabel;
exports.toWireStatus = toWireStatus;
exports.toRoadmapStatusCell = toRoadmapStatusCell;
exports.toDiskStatus = toDiskStatus;
exports.toCompletionStatus = toCompletionStatus;
exports.toProgressStatus = toProgressStatus;
exports.matchRoadmapStatusCell = matchRoadmapStatusCell;
exports.parseRoadmapStatusCell = parseRoadmapStatusCell;
// ─── Closed vocabularies ───────────────────────────────────────────────────
/** The lifecycle ladder, lowest rung first. */
exports.PHASE_STATUS = Object.freeze({
    NOT_STARTED: 'NOT_STARTED',
    PLANNED: 'PLANNED',
    IN_PROGRESS: 'IN_PROGRESS',
    EXECUTED: 'EXECUTED',
    NEEDS_REVIEW: 'NEEDS_REVIEW',
    COMPLETE: 'COMPLETE',
});
/**
 * The three-value wire vocabulary published by `.planning/state.json`
 * (`phases[].status`) and the Workstream Inventory (`PhaseStatus.status`).
 */
exports.WIRE_STATUS = Object.freeze({
    COMPLETE: 'complete',
    IN_PROGRESS: 'in_progress',
    PENDING: 'pending',
});
/**
 * The ROADMAP `## Progress` table Status-cell vocabulary: the template's
 * `Not started | In progress | Complete | Deferred` plus the `Planned` word
 * `roadmap update-plan-progress` writes. `In Progress` is spelled the way the
 * writers have always written it.
 */
exports.ROADMAP_STATUS_TOKEN = Object.freeze({
    NOT_STARTED: 'Not started',
    PLANNED: 'Planned',
    IN_PROGRESS: 'In Progress',
    COMPLETE: 'Complete',
    DEFERRED: 'Deferred',
});
/** `roadmap analyze` / `init manager`'s `disk_status` vocabulary (ADR-5057 §1.2). */
exports.DISK_STATUS = Object.freeze({
    COMPLETE: 'complete',
    EXECUTED: 'executed',
    PARTIAL: 'partial',
    PLANNED: 'planned',
    RESEARCHED: 'researched',
    DISCUSSED: 'discussed',
    EMPTY: 'empty',
    NO_DIRECTORY: 'no_directory',
});
/** `init progress`'s per-phase `status` vocabulary (ADR-5057 §1.2). */
exports.PROGRESS_STATUS = Object.freeze({
    COMPLETE: 'complete',
    EXECUTED: 'executed',
    IN_PROGRESS: 'in_progress',
    RESEARCHED: 'researched',
    PENDING: 'pending',
    NOT_STARTED: 'not_started',
});
/** `init`'s `completion_status` vocabulary (ADR-5057 §1.2). */
exports.COMPLETION_STATUS = Object.freeze({
    COMPLETE: 'complete',
    EXECUTED: 'executed',
    INCOMPLETE: 'incomplete',
});
const LADDER = Object.freeze([
    exports.PHASE_STATUS.NOT_STARTED,
    exports.PHASE_STATUS.PLANNED,
    exports.PHASE_STATUS.IN_PROGRESS,
    exports.PHASE_STATUS.EXECUTED,
    exports.PHASE_STATUS.NEEDS_REVIEW,
    exports.PHASE_STATUS.COMPLETE,
]);
const LADDER_RANK = new Map(LADDER.map((s, i) => [s, i]));
function assertPhaseStatus(value, where) {
    if (typeof value !== 'string' || !LADDER_RANK.has(value)) {
        throw new TypeError(`${where}: ${JSON.stringify(value)} is not a PHASE_STATUS value`);
    }
}
function assertCount(value, name) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new TypeError(`phaseStatusFromFacts: ${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
}
/**
 * The ladder. First matching rung wins:
 *   complete                     → COMPLETE     (disk-strict: no plan precondition, #3168)
 *   no plans                     → NOT_STARTED
 *   no summaries                 → PLANNED
 *   fewer summaries than plans   → IN_PROGRESS
 *   verification `human_needed`  → NEEDS_REVIEW
 *   otherwise                    → EXECUTED     (gaps_found, stale, missing, unparseable, phase_dir_not_found)
 *
 * `verificationStatus`, when non-null, must be a VerificationStatus member
 * (#5118) — the same fail-where-produced rule as `assertPhaseStatus`.
 *
 * Completion comes ONLY from `complete`. The ladder never restates a
 * summary-versus-plan completion comparison (scripts/lint-completion-predicate-drift.cjs shape (c)).
 */
function phaseStatusFromFacts(facts) {
    if (facts === null || typeof facts !== 'object') {
        throw new TypeError('phaseStatusFromFacts: facts object required');
    }
    const { planCount, summaryCount, complete, verificationStatus } = facts;
    assertCount(planCount, 'planCount');
    assertCount(summaryCount, 'summaryCount');
    if (typeof complete !== 'boolean') {
        throw new TypeError(`phaseStatusFromFacts: complete must be a boolean, got ${JSON.stringify(complete)}`);
    }
    const { verification } = owners();
    if (verificationStatus !== null && verificationStatus !== undefined) {
        // Called through a plain function type: a lazily-required owner's
        // assertion signature cannot narrow here (TS2775), and needs not to.
        const assertMember = verification.assertVerificationStatus;
        assertMember(verificationStatus, 'phaseStatusFromFacts: verificationStatus');
    }
    if (complete)
        return exports.PHASE_STATUS.COMPLETE;
    if (planCount === 0)
        return exports.PHASE_STATUS.NOT_STARTED;
    if (summaryCount === 0)
        return exports.PHASE_STATUS.PLANNED;
    if (summaryCount < planCount)
        return exports.PHASE_STATUS.IN_PROGRESS;
    if (verificationStatus === verification.VERIFICATION_STATUS.HUMAN_NEEDED)
        return exports.PHASE_STATUS.NEEDS_REVIEW;
    return exports.PHASE_STATUS.EXECUTED;
}
const SCOPE_SEVERITY = Object.freeze({
    complete: 0,
    truncated: 1,
    unscoped: 2,
    unreadable: 3,
});
let _verification = null;
let _planScan = null;
function owners() {
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (!_verification)
        _verification = require('./verification.cjs');
    if (!_planScan)
        _planScan = require('./plan-scan.cjs');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return { verification: _verification, planScan: _planScan };
}
/**
 * What state is the phase in `phaseDir` in? Composes only ADR-3180's §7
 * owners. `scope` is the worse of the plan scan's and the completion read's
 * scopes, so a caller can tell "not started" from "could not look".
 */
function phaseStatus(phaseDir, deps = {}) {
    const { verification, planScan } = owners();
    const scan = planScan.scanPhasePlans(phaseDir);
    const completion = verification.isPhaseComplete(phaseDir, {
        convention: deps.convention,
        fs: deps.fs,
        phaseCleanCommitTimesMs: deps.phaseCleanCommitTimesMs,
    });
    const status = phaseStatusFromFacts({
        planCount: scan.planCount,
        summaryCount: scan.summaryCount,
        complete: completion.value.complete,
        verificationStatus: completion.value.verification.status,
    });
    const scope = (SCOPE_SEVERITY[completion.scope] ?? 0) > (SCOPE_SEVERITY[scan.scope] ?? 0)
        ? completion.scope
        : scan.scope;
    return {
        value: {
            status,
            planCount: scan.planCount,
            summaryCount: scan.summaryCount,
            verification: completion.value.verification,
            ...(completion.value.statusError ? { statusError: completion.value.statusError } : {}),
        },
        scope,
    };
}
// ─── Fold (#2408) ──────────────────────────────────────────────────────────
/**
 * Fold two statuses for directories that collide on one phase key (#2408):
 * the further-along rung wins. Commutative, idempotent and associative, so
 * `readdirSync` order cannot change the answer.
 */
function foldPhaseStatuses(a, b) {
    assertPhaseStatus(a, 'foldPhaseStatuses');
    assertPhaseStatus(b, 'foldPhaseStatuses');
    return LADDER_RANK.get(a) >= LADDER_RANK.get(b) ? a : b;
}
const DISPLAY_LABEL = Object.freeze({
    [exports.PHASE_STATUS.NOT_STARTED]: 'Not Started',
    [exports.PHASE_STATUS.PLANNED]: 'Planned',
    [exports.PHASE_STATUS.IN_PROGRESS]: 'In Progress',
    [exports.PHASE_STATUS.EXECUTED]: 'Executed',
    [exports.PHASE_STATUS.NEEDS_REVIEW]: 'Needs Review',
    [exports.PHASE_STATUS.COMPLETE]: 'Complete',
});
/**
 * The label `progress`, `stats`, `init plan-phase` and `gsd-health` show. The
 * NOT_STARTED word is the caller's display choice (`progress` and `init` say
 * `Pending`, `stats` and the health rule say `Not Started`).
 */
function toDisplayLabel(status, opts = {}) {
    assertPhaseStatus(status, 'toDisplayLabel');
    const pendingWord = opts.pendingWord ?? 'Not Started';
    if (pendingWord !== 'Pending' && pendingWord !== 'Not Started') {
        throw new TypeError(`toDisplayLabel: pendingWord must be 'Pending' or 'Not Started', got ${JSON.stringify(pendingWord)}`);
    }
    return status === exports.PHASE_STATUS.NOT_STARTED ? pendingWord : DISPLAY_LABEL[status];
}
/** `pending` means nothing is planned yet; every rung between that and COMPLETE is `in_progress`. */
function toWireStatus(status) {
    assertPhaseStatus(status, 'toWireStatus');
    if (status === exports.PHASE_STATUS.COMPLETE)
        return exports.WIRE_STATUS.COMPLETE;
    if (status === exports.PHASE_STATUS.NOT_STARTED)
        return exports.WIRE_STATUS.PENDING;
    return exports.WIRE_STATUS.IN_PROGRESS;
}
/** The word a ROADMAP writer puts in the Status cell for this rung. */
function toRoadmapStatusCell(status) {
    assertPhaseStatus(status, 'toRoadmapStatusCell');
    switch (status) {
        case exports.PHASE_STATUS.COMPLETE: return exports.ROADMAP_STATUS_TOKEN.COMPLETE;
        case exports.PHASE_STATUS.PLANNED: return exports.ROADMAP_STATUS_TOKEN.PLANNED;
        case exports.PHASE_STATUS.NOT_STARTED: return exports.ROADMAP_STATUS_TOKEN.NOT_STARTED;
        default: return exports.ROADMAP_STATUS_TOKEN.IN_PROGRESS;
    }
}
/**
 * `roadmap analyze` / `init manager`'s `disk_status`. Below NOT_STARTED the
 * word records which pre-planning artifacts exist. (`no_directory` is the
 * callers' own word for "no directory matched" — there is no phase to ask.)
 */
function toDiskStatus(status, artifacts) {
    assertPhaseStatus(status, 'toDiskStatus');
    switch (status) {
        case exports.PHASE_STATUS.COMPLETE: return exports.DISK_STATUS.COMPLETE;
        case exports.PHASE_STATUS.NEEDS_REVIEW:
        case exports.PHASE_STATUS.EXECUTED: return exports.DISK_STATUS.EXECUTED;
        case exports.PHASE_STATUS.IN_PROGRESS: return exports.DISK_STATUS.PARTIAL;
        case exports.PHASE_STATUS.PLANNED: return exports.DISK_STATUS.PLANNED;
        default:
            if (artifacts.hasResearch)
                return exports.DISK_STATUS.RESEARCHED;
            if (artifacts.hasContext)
                return exports.DISK_STATUS.DISCUSSED;
            return exports.DISK_STATUS.EMPTY;
    }
}
/** `init`'s `completion_status`: complete / executed / incomplete. */
function toCompletionStatus(status) {
    assertPhaseStatus(status, 'toCompletionStatus');
    if (status === exports.PHASE_STATUS.COMPLETE)
        return exports.COMPLETION_STATUS.COMPLETE;
    if (status === exports.PHASE_STATUS.EXECUTED || status === exports.PHASE_STATUS.NEEDS_REVIEW)
        return exports.COMPLETION_STATUS.EXECUTED;
    return exports.COMPLETION_STATUS.INCOMPLETE;
}
/** `init progress`'s per-phase `status`. */
function toProgressStatus(status, artifacts) {
    assertPhaseStatus(status, 'toProgressStatus');
    switch (status) {
        case exports.PHASE_STATUS.COMPLETE: return exports.PROGRESS_STATUS.COMPLETE;
        case exports.PHASE_STATUS.NEEDS_REVIEW:
        case exports.PHASE_STATUS.EXECUTED: return exports.PROGRESS_STATUS.EXECUTED;
        case exports.PHASE_STATUS.IN_PROGRESS:
        case exports.PHASE_STATUS.PLANNED: return exports.PROGRESS_STATUS.IN_PROGRESS;
        default: return artifacts.hasResearch ? exports.PROGRESS_STATUS.RESEARCHED : exports.PROGRESS_STATUS.PENDING;
    }
}
// ─── ROADMAP Status cell reader ────────────────────────────────────────────
// Leading token of a trimmed cell, case-insensitive, a whitespace run allowed
// inside the two-word tokens, and `(?!\w)` so `Completed` / `Planning` are not
// tokens. #4925 lets operator prose follow the token; that prose is ignored.
const CELL_TOKEN_RE = /^(not\s+started|planned|in\s+progress|complete|deferred)(?!\w)/i;
const TOKEN_BY_KEY = Object.freeze({
    'not started': exports.ROADMAP_STATUS_TOKEN.NOT_STARTED,
    planned: exports.ROADMAP_STATUS_TOKEN.PLANNED,
    'in progress': exports.ROADMAP_STATUS_TOKEN.IN_PROGRESS,
    complete: exports.ROADMAP_STATUS_TOKEN.COMPLETE,
    deferred: exports.ROADMAP_STATUS_TOKEN.DEFERRED,
});
/**
 * Read a Status cell's leading token. Returns the canonical token and the raw
 * text it matched (writers compare `text` to decide whether a rewrite is a
 * no-op), or null when the cell has no leading token. Never throws.
 */
function matchRoadmapStatusCell(cell) {
    if (typeof cell !== 'string')
        return null;
    const m = CELL_TOKEN_RE.exec(cell.trim());
    if (!m)
        return null;
    const key = m[1].toLowerCase().replace(/\s+/g, ' ');
    return { token: TOKEN_BY_KEY[key], text: m[1] };
}
/**
 * A Status cell as a wire value. `Deferred`, `Not started`, a cell with no
 * leading token, and a non-string all read `pending` — an unrecognized cell
 * never becomes a fourth wire value. Inverse of `toRoadmapStatusCell` under
 * `toWireStatus` (ADR-5057 Phase 1 property).
 */
function parseRoadmapStatusCell(cell) {
    const m = matchRoadmapStatusCell(cell);
    if (m === null)
        return exports.WIRE_STATUS.PENDING;
    switch (m.token) {
        case exports.ROADMAP_STATUS_TOKEN.COMPLETE: return exports.WIRE_STATUS.COMPLETE;
        case exports.ROADMAP_STATUS_TOKEN.IN_PROGRESS:
        case exports.ROADMAP_STATUS_TOKEN.PLANNED: return exports.WIRE_STATUS.IN_PROGRESS;
        default: return exports.WIRE_STATUS.PENDING;
    }
}
