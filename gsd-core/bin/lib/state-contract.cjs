"use strict";
/**
 * State Contract Module — `.planning/state.json` schema v1 (#3227).
 *
 * A **best-effort publisher** invoked at 11 step-boundary commands
 * (`state.*`, `phase.*`, `milestone.complete`). It composes existing
 * canonical owners; it introduces no second answer to any question GSD
 * already answers:
 *   - `planning-workspace.cjs`'s `planningPaths` for every `.planning/` path
 *     (workstream-aware — never re-derived here).
 *   - `roadmap-progress.cjs`'s `locateRoadmapProgress` (#5761; was
 *     `phase-lifecycle`'s `locateProgressTable`) for
 *     "where is the Progress table" — the SAME table
 *     `deriveProgressFromRoadmap` counts from, so `phases[]` and
 *     `deriveProgressFromRoadmap`'s `totalPhases` can never disagree about
 *     which rows are data rows.
 *   - `phase-id.cjs`'s `isSentinelPhaseId` / `parsePhaseFromProse` for
 *     sentinel exclusion and STATE.md phase-token parsing.
 *   - `roadmap-parser.cjs`'s `getMilestoneInfo` for milestone identity.
 *   - `markdown-sectionizer.cjs`'s `collectSection` for the `## Phases`
 *     checkbox fallback.
 *   - `state-document.cjs`'s `stateFieldValue` + `frontmatter.cjs`'s
 *     `extractFrontmatter`/`stripFrontmatter` for STATE.md's `current_phase`.
 *   - `shell-command-projection.cjs`'s `platformReadSync`/`platformWriteSync`
 *     — the CLAUDE.md-designated single OS-facing I/O seam. `platformWriteSync`
 *     is ALREADY atomic (sibling tmp + `retryRenameSync`, Windows transient-
 *     lock retry, EXDEV fallback) — this module adds no sixth atomic-write
 *     helper (the repo already carries five).
 *   - `smart-entry.cjs`'s `classifyProject` for `next` — this is what makes
 *     "`next` equals smart-entry's recommended action" true BY CONSTRUCTION
 *     rather than by a second copy of the routing table.
 *
 * WHY NOT `PlanningSnapshot` / `buildPlanningInspect`. `PlanningSnapshot` is
 * an explicitly-additive INTERNAL diagnostic shape (ADR-3180 §8.1) still
 * growing across phases; freezing it as an external contract is the exact
 * Hyrum's-Law break `planning.inspect` (`src/planning-inspect.cts`) already
 * refused for the same reason (#2790). `state.json` declares its OWN flat,
 * minimal, six-key schema instead — see PUBLIC SURFACE below.
 *
 * NOT built (Gall's Law / Zawinski's Law — see `.gsd/phase/feat-3227-state-
 * contract/40-design.md`): a `--watch` mode, a reader API inside gsd-core, a
 * diff/event stream, a config toggle, milestone-scoping of `phases[]`. This
 * module answers "where is this project right now" and nothing else — a
 * request for document *contents* belongs to `planning.inspect`.
 *
 * REQUIRE-CYCLE HAZARD (the single most important implementation
 * constraint). `src/state.cts` imports THIS module, and `src/smart-entry.cts`
 * imports `state.cjs` and destructures `readStateHeadFreshness` off it at
 * MODULE LOAD time. A top-level `import smartEntry = require('./smart-entry.cjs')`
 * here would therefore close the cycle
 * `state.cjs -> state-contract.cjs -> smart-entry.cjs -> state.cjs`, binding
 * `readStateHeadFreshness` to `undefined` inside `smart-entry.cjs` and
 * throwing at its first call. Every owner below is required LAZILY, inside
 * the function body, via a small cached loader — never at module top level —
 * which also keeps this module's (and its owners') load cost off every
 * command that imports `state.cjs` but never reaches a publish boundary.
 * Someone will be tempted to "tidy" the lazy requires into top-level ones;
 * doing so reopens the cycle.
 *
 * `withPlanningLock` is deliberately NOT taken around the write (Rejected §3
 * of the design doc): it is not re-entrant, several phase commands already
 * hold it when they would call this publisher, and `platformWriteSync`'s
 * tmp+rename already makes each publish all-or-nothing without it.
 *
 * ADR-457 build-at-publish: source in src/state-contract.cts, compiled to
 * gsd-core/bin/lib/state-contract.cjs (gitignored).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUBLISH_REASON = exports.PHASE_STATUS = exports.PHASE_KEY_ORDER = exports.CONTRACT_KEY_ORDER = exports.STATE_CONTRACT_FLAVOR = exports.STATE_CONTRACT_VERSION = void 0;
exports.buildStateContract = buildStateContract;
exports.publishStateContract = publishStateContract;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
// #5060: `phase-status.cjs` is a LOAD-TIME LEAF — no top-level requires of
// its own (verification.cjs/plan-scan.cjs are required lazily, only inside
// `phaseStatus()`) — so importing it here at top level does not reopen the
// documented `state.cjs -> state-contract.cjs -> smart-entry.cjs -> state.cjs`
// require cycle the file header warns about.
const phase_status_cjs_1 = require("./phase-status.cjs");
const phase_entry_grammar_cjs_1 = require("./phase-entry-grammar.cjs");
// ─── Public wire vocabulary ────────────────────────────────────────────────
exports.STATE_CONTRACT_VERSION = '1.0.0';
exports.STATE_CONTRACT_FLAVOR = 'core';
/** Key order of the emitted contract object — an observable, pinned by test. */
exports.CONTRACT_KEY_ORDER = Object.freeze(['contract', 'flavor', 'milestone', 'phases', 'next', 'updated_at']);
/** Key order of each emitted phase object — an observable, pinned by test. */
exports.PHASE_KEY_ORDER = Object.freeze(['number', 'name', 'status']);
/**
 * Frozen three-value phase status vocabulary. Conservative in what we send
 * (Postel's Law). #5060: identity-pinned to the Phase Status Module's own
 * `WIRE_STATUS` — this is not a copy, it IS that frozen object, so
 * `state-contract`'s `PHASE_STATUS` and `phase-status.cjs`'s `WIRE_STATUS`
 * can never independently drift.
 */
exports.PHASE_STATUS = phase_status_cjs_1.WIRE_STATUS;
/** Frozen `publishStateContract` result reasons. */
exports.PUBLISH_REASON = Object.freeze({
    PUBLISHED: 'published',
    NO_PLANNING_DIR: 'no_planning_dir',
    WRITE_FAILED: 'write_failed',
});
let _owners = null;
/**
 * Lazily require every owner this module composes. MUST stay lazy — see the
 * "REQUIRE-CYCLE HAZARD" module-doc comment above. Cached after first call so
 * repeat invocations within one process (multiple publishes in one command,
 * or across the several boundary commands in a test run) pay the require
 * cost once.
 */
function owners() {
    if (_owners)
        return _owners;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const planningWorkspaceMod = require('./planning-workspace.cjs');
    const shellCommandProjectionMod = require('./shell-command-projection.cjs');
    const roadmapProgressMod = require('./roadmap-progress.cjs');
    const phaseIdMod = require('./phase-id.cjs');
    const roadmapParserMod = require('./roadmap-parser.cjs');
    const markdownSectionizerMod = require('./markdown-sectionizer.cjs');
    const stateDocumentMod = require('./state-document.cjs');
    const frontmatterMod = require('./frontmatter.cjs');
    const smartEntryMod = require('./smart-entry.cjs');
    /* eslint-enable @typescript-eslint/no-require-imports */
    _owners = {
        planningPaths: planningWorkspaceMod.planningPaths,
        platformReadSync: shellCommandProjectionMod.platformReadSync,
        platformWriteSync: shellCommandProjectionMod.platformWriteSync,
        locateRoadmapProgress: roadmapProgressMod.locateRoadmapProgress,
        isSentinelPhaseId: phaseIdMod.isSentinelPhaseId,
        parsePhaseFromProse: phaseIdMod.parsePhaseFromProse,
        resolvePhaseIdConvention: planningWorkspaceMod.resolvePhaseIdConvention,
        getMilestoneInfo: roadmapParserMod.getMilestoneInfo,
        collectSection: markdownSectionizerMod.collectSection,
        stateFieldValue: stateDocumentMod.stateFieldValue,
        extractFrontmatter: frontmatterMod.extractFrontmatter,
        stripFrontmatter: frontmatterMod.stripFrontmatter,
        classifyProject: smartEntryMod.classifyProject,
    };
    return _owners;
}
// ─── milestone ──────────────────────────────────────────────────────────────
function buildMilestone(cwd) {
    try {
        const { value } = owners().getMilestoneInfo(cwd);
        if (!value)
            return null;
        // U+2014 EM DASH, spaced on both sides. Never fabricate a name — version
        // alone when no name-bearing evidence resolved (design row 21).
        return value.name && value.name.length > 0 ? `${value.version} — ${value.name}` : value.version;
    }
    catch {
        return null;
    }
}
// ─── phases: Progress-table (primary) enumerator ───────────────────────────
const PHASE_CELL_RE = /^(\d+(?:\.\d+)*)\s*[.:)–—-]?\s*(.*)$/;
// #5626: under `milestone-prefixed` the phase id is the whole `M-NN` (`3-01`), so the number capture takes
// one optional `-NN` segment. Chosen by the convention value alone: every other convention keeps the
// dotted-only capture above, and the `\d+-\d+` shape stays an ordinary leading integer there.
const MILESTONE_PREFIXED = 'milestone-prefixed';
const PHASE_CELL_MILESTONE_RE = /^(\d+(?:-\d+)?(?:\.\d+)*)\s*[.:)–—-]?\s*(.*)$/;
/** The project's `phase_id_convention` (null when unset or unreadable), through its one owner. */
function phaseIdConventionOf(cwd) {
    try {
        return owners().resolvePhaseIdConvention(cwd);
    }
    catch {
        return null;
    }
}
function phasesFromProgressTable(table, convention) {
    const { isSentinelPhaseId } = owners();
    const phases = [];
    const cellRe = convention === MILESTONE_PREFIXED ? PHASE_CELL_MILESTONE_RE : PHASE_CELL_RE;
    for (const row of table.rows) {
        const cell = (row['Phase'] ?? '').trim();
        if (!/^\d/.test(cell))
            continue; // stray note row, no leading digit
        if (isSentinelPhaseId(cell))
            continue; // phase 0 / 999.x sentinels
        const m = cellRe.exec(cell);
        const number = m ? m[1] : cell;
        const name = m && m[2].trim().length > 0 ? m[2].trim() : null;
        phases.push({ number, name, status: (0, phase_status_cjs_1.parseRoadmapStatusCell)(row['Status']) });
    }
    return phases;
}
// ─── phases: `## Phases` checkbox fallback ─────────────────────────────────
// `- [x] **Phase 1: Foundation**` / `- [ ] **Phase 2.1: Hardening**`.
// The entry prefix (marker, box, bold token) is the phase-entry grammar's (#5764): capture
// group 1 is the box character, 2 the number, 3 the name.
const PHASE_BULLET_RE = (0, phase_entry_grammar_cjs_1.phaseEntryRegExp)(`Phase[ \\t]+(\\d+(?:\\.\\d+)*)[ \\t]*:?[ \\t]*([^*\\n]*)${phase_entry_grammar_cjs_1.PHASE_ENTRY_BOLD_CLOSE_SRC}`, 'g', { state: 'captured', bold: 'required' });
// #5626: the same bullet under `milestone-prefixed`: the number capture takes one optional `-NN` segment.
const PHASE_BULLET_MILESTONE_RE = (0, phase_entry_grammar_cjs_1.phaseEntryRegExp)(`Phase[ \\t]+(\\d+(?:-\\d+)?(?:\\.\\d+)*)[ \\t]*:?[ \\t]*([^*\\n]*)${phase_entry_grammar_cjs_1.PHASE_ENTRY_BOLD_CLOSE_SRC}`, 'g', { state: 'captured', bold: 'required' });
/**
 * STATE.md's current phase, via the same frontmatter-then-body chain
 * `cmdStateCompletePhase` uses (`stateFieldValue` owns the #1760 fallback
 * ladder). Any failure anywhere in the chain yields `null` — treat current
 * phase as unknown so every unchecked bullet is PENDING rather than
 * IN_PROGRESS by a guess.
 */
function currentPhaseFromState(statePath, convention) {
    const { platformReadSync, extractFrontmatter, stripFrontmatter, stateFieldValue, parsePhaseFromProse } = owners();
    try {
        const raw = platformReadSync(statePath);
        if (raw === null)
            return null;
        const fm = extractFrontmatter(raw, statePath);
        const body = stripFrontmatter(raw);
        const { value } = stateFieldValue(fm, body, 'current_phase', 'Current Phase');
        if (!value)
            return null;
        return parsePhaseFromProse(value, convention).phase;
    }
    catch {
        return null;
    }
}
/**
 * Fallback enumerator when the ROADMAP carries no Progress table.
 *
 * Scoping to `## Phases` is load-bearing negative space (design "Not-
 * corruption" section): it is what keeps `- [x] 01-01: a plan` (a PLAN
 * bullet under `## Phase Details`) and `- ✅ **v1.0 MVP** - Phases 1-4`
 * (a MILESTONE bullet under `## Milestones`) from being read as phases. The
 * `**Phase N` anchor inside `PHASE_BULLET_RE` is the second layer of that
 * defence — a plan bullet's text never starts with `**Phase`.
 */
function phasesFromChecklist(roadmapContent, cwd, statePath, convention) {
    const { collectSection, isSentinelPhaseId } = owners();
    const section = collectSection(roadmapContent, (h) => /^phases$/i.test(h.text.trim()));
    if (!section)
        return [];
    const currentPhase = currentPhaseFromState(statePath, convention);
    const phases = [];
    let match;
    const bulletRe = convention === MILESTONE_PREFIXED ? PHASE_BULLET_MILESTONE_RE : PHASE_BULLET_RE;
    const pattern = new RegExp(bulletRe.source, bulletRe.flags);
    while ((match = pattern.exec(section.body)) !== null) {
        const checked = match[1] === 'x' || match[1] === 'X';
        const number = match[2];
        if (isSentinelPhaseId(number))
            continue;
        const name = match[3].replace(/\r$/, '').trim();
        const status = checked
            ? exports.PHASE_STATUS.COMPLETE
            : (currentPhase !== null && number === currentPhase ? exports.PHASE_STATUS.IN_PROGRESS : exports.PHASE_STATUS.PENDING);
        phases.push({ number, name: name.length > 0 ? name : null, status });
    }
    return phases;
}
function buildPhases(cwd, paths) {
    const { platformReadSync, locateRoadmapProgress } = owners();
    try {
        let content = platformReadSync(paths.roadmap);
        if (content === null)
            return [];
        if (content.charCodeAt(0) === 0xfeff)
            content = content.slice(1); // strip leading BOM
        const convention = phaseIdConventionOf(cwd);
        const { table } = locateRoadmapProgress(content);
        if (table)
            return phasesFromProgressTable(table, convention);
        return phasesFromChecklist(content, cwd, paths.state, convention);
    }
    catch {
        return [];
    }
}
// ─── next ───────────────────────────────────────────────────────────────────
function buildNext(cwd, deps) {
    try {
        const classify = deps?.classify ?? owners().classifyProject;
        const result = classify(cwd);
        const action = result.actions.find((a) => a.id === result.recommended);
        if (!action)
            return null;
        return { command: action.command, label: action.label, reason: result.summary };
    }
    catch {
        return null;
    }
}
// ─── Entry points ───────────────────────────────────────────────────────────
/**
 * Build the state-contract snapshot. PURE — writes nothing. Every stage is
 * independently try/caught (milestone, phases, next) so one bad document
 * cannot lose the others; `updated_at` and the frozen `contract`/`flavor`
 * keys always resolve.
 */
function buildStateContract(cwd, deps) {
    const nowFn = deps?.now ?? Date.now;
    const updated_at = new Date(nowFn()).toISOString();
    // #2245 shape: `planningPaths` -> `planningDir` throws a plain Error for an
    // invalid GSD_WORKSTREAM/GSD_PROJECT segment. This call must not be hoisted
    // outside a try, or that throw escapes uncaught and breaks the invariant
    // this function is documented as upholding (see `getMilestoneInfo`'s
    // equivalent guard comment in src/roadmap-parser.cts for the same shape).
    let paths;
    try {
        paths = owners().planningPaths(cwd);
    }
    catch {
        paths = null;
    }
    if (!paths) {
        return {
            contract: exports.STATE_CONTRACT_VERSION,
            flavor: exports.STATE_CONTRACT_FLAVOR,
            milestone: null,
            phases: [],
            next: null,
            updated_at,
        };
    }
    const milestone = buildMilestone(cwd);
    const phases = buildPhases(cwd, paths);
    const next = buildNext(cwd, deps);
    return {
        contract: exports.STATE_CONTRACT_VERSION,
        flavor: exports.STATE_CONTRACT_FLAVOR,
        milestone,
        phases,
        next,
        updated_at,
    };
}
/**
 * Publish the state-contract snapshot to `<planning>/state.json`. NEVER
 * throws — for any input, ever (acceptance criterion 3: the parent boundary
 * command's exit code and stdout must be unchanged whatever happens here).
 *
 * No `.planning/` directory at all: writes nothing, creates nothing. This
 * guard is essential — `platformWriteSync` does `mkdirSync(dirname,
 * {recursive:true})`, so without it the publisher would conjure a
 * `.planning/` tree inside a non-GSD directory.
 *
 * `withPlanningLock` is deliberately NOT taken here — see the module-doc
 * "REQUIRE-CYCLE HAZARD" section's sibling note: it is not re-entrant and
 * several phase commands already hold it when they call this publisher, so
 * acquiring it here would throw in exactly the situation this function must
 * never perturb. `platformWriteSync`'s sibling-tmp + rename already makes
 * each publish all-or-nothing without it.
 */
function publishStateContract(cwd, deps) {
    try {
        const { planningPaths, platformWriteSync } = owners();
        // Resolve the planning root BEFORE anything else. A resolution failure
        // (invalid GSD_WORKSTREAM/GSD_PROJECT segment — the #2245 shape) means no
        // write was ever attempted, so it must map to `no_planning_dir`, not
        // `write_failed` — that reason is reserved for an attempted-and-failed
        // write, and reporting it here would send a caller looking at disk
        // permissions for a problem that isn't there.
        let paths;
        try {
            paths = planningPaths(cwd);
        }
        catch {
            return { published: false, reason: exports.PUBLISH_REASON.NO_PLANNING_DIR };
        }
        if (!node_fs_1.default.existsSync(paths.planning)) {
            return { published: false, reason: exports.PUBLISH_REASON.NO_PLANNING_DIR };
        }
        const snapshot = buildStateContract(cwd, deps);
        const statePath = node_path_1.default.join(paths.planning, 'state.json');
        try {
            platformWriteSync(statePath, JSON.stringify(snapshot, null, 2) + '\n');
        }
        catch {
            return { published: false, reason: exports.PUBLISH_REASON.WRITE_FAILED };
        }
        return { published: true, reason: exports.PUBLISH_REASON.PUBLISHED };
    }
    catch {
        return { published: false, reason: exports.PUBLISH_REASON.WRITE_FAILED };
    }
}
