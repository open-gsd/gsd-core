"use strict";
/**
 * Canonical GSD artifact registry (ADR-457 build-at-publish: the hand-written
 * bin/lib/artifacts.cjs collapsed to a TypeScript source of truth). Behaviour
 * is preserved byte-for-behaviour from the prior hand-written .cjs; only types
 * are added.
 *
 * Enumerates the file names that gsd workflows officially produce at the
 * .planning/ root level. Used by gsd-health (W019) to flag unrecognized files
 * so stale or misnamed artifacts don't silently mislead agents or reviewers.
 *
 * Add entries here whenever a new workflow produces a .planning/ root file.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANONICAL_PATTERNS = exports.CANONICAL_EXACT = void 0;
exports.isCanonicalPlanningFile = isCanonicalPlanningFile;
// Exact-match canonical file names at .planning/ root
exports.CANONICAL_EXACT = new Set([
    'PROJECT.md',
    'ROADMAP.md',
    'STATE.md',
    'REQUIREMENTS.md',
    'MILESTONES.md',
    'BACKLOG.md',
    'LEARNINGS.md',
    'THREADS.md',
    'config.json',
    'CLAUDE.md',
    'RETROSPECTIVE.md',
    'WINDOWS.md', // #3224: broken-windows ledger (src/broken-windows.cts, LEDGER_FILE_NAME)
    'STATE-ARCHIVE.md', // state.cts's cmdStatePrune writes this at the .planning/ root
    'milestone.lock', // #3311: milestone (phase + session) claim (src/milestone-lock.cts); persistent, unlike the transient STATE.md.lock/WAITING.json
    'state.json', // #3227: machine-readable state contract published at step boundaries (src/state-contract.cts)
    'skill-manifest.json', // init.cts cmdSkillManifest --write (project-scoped planning root, #3964)
    'PATTERNS.md', // #4282: graduated cross-phase patterns (workflows/graduation.md, `patterns` target) -- distinct from the per-phase NN-PATTERNS.md (templates/README.md)
]);
// Pattern-match canonical file names (regex tests on the basename)
// Each pattern includes the name of the workflow that produces it as a comment.
exports.CANONICAL_PATTERNS = [
    /^v\d+\.\d+(?:\.\d+)?-MILESTONE-AUDIT\.md$/i, // gsd-complete-milestone (pre-archive)
    /^v\d+\.\d+(?:\.\d+)?-.*\.md$/i, // other version-stamped planning docs
];
/**
 * Return true if `filename` (basename only, no path) matches a canonical
 * .planning/ root artifact — either an exact name or a known pattern.
 *
 * @param filename - Basename of the file (e.g. "STATE.md")
 */
function isCanonicalPlanningFile(filename) {
    if (exports.CANONICAL_EXACT.has(filename))
        return true;
    for (const pattern of exports.CANONICAL_PATTERNS) {
        if (pattern.test(filename))
            return true;
    }
    return false;
}
