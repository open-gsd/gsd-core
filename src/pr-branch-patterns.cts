/**
 * PR-branch `.planning/` path classification patterns — single source of
 * truth (ADR-4910 §8, epic #4906 Phase 5; issues #4605, #4606).
 *
 * `gsd-core/workflows/pr-branch.md` cannot `require()` this module at
 * runtime — a workflow markdown file has no module system, and its bash
 * steps are copy-pasted text executed by whatever shell interprets the
 * workflow. So the three exported constants below are mirrored VERBATIM
 * into that file's `TRANSIENT_DIRS=`, `STRUCTURAL_RE=`, and
 * `MILESTONE_PHASES_RE=` bash variable assignments, and
 * `scripts/lint-pr-branch-pattern-drift.cjs` asserts the mirror never
 * drifts from this file (compiled to `gsd-core/bin/lib/pr-branch-patterns.cjs`)
 * as part of `npm run lint:ci`. Change a value here, then update
 * `gsd-core/workflows/pr-branch.md` to match, or the drift guard fails.
 *
 * This module does not read the filesystem and has no dependencies (a leaf
 * module, mirroring `src/secrets.cts` / `src/planning-scope.cts`).
 */

/**
 * Space-separated list of `.planning/` subdirectory names that are reviewer
 * noise (PLAN.md, SUMMARY.md, CONTEXT.md, RESEARCH.md, and friends) —
 * filtered out of a PR branch in BOTH default and strict mode.
 *
 * Mirrored verbatim into `gsd-core/workflows/pr-branch.md`'s
 * `TRANSIENT_DIRS="..."` assignment.
 */
export const TRANSIENT_DIRS_SRC = 'phases quick research threads todos debug seeds codebase ui-reviews';

/**
 * Structural planning files — repository planning state, preserved in
 * default mode and filtered out in strict mode. Anchored on both
 * alternatives so `.planning/STATEX.md` and `.planning/STATE.md.bak` are
 * NOT treated as structural. The `milestones` alternative matches only
 * FILES directly under `.planning/milestones/` (e.g. `v1.0-ROADMAP.md`) —
 * not a `<milestone>-phases/` subdirectory nested there. That subdirectory
 * is reviewer noise, not structural state (#4605); it falls through to
 * `MILESTONE_PHASES_RE_SRC` below instead.
 *
 * Mirrored verbatim into `gsd-core/workflows/pr-branch.md`'s
 * `STRUCTURAL_RE="..."` assignment.
 */
export const STRUCTURAL_RE_SRC = '^\\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\\.md$|^\\.planning/milestones/[^/]+\\.md$';

/**
 * Milestone-scoped phase-plan directories — the same reviewer noise as
 * `TRANSIENT_DIRS_SRC`'s `phases` entry, but nested per-milestone once a
 * project has passed at least one milestone:
 * `.planning/milestones/<milestone>-phases/`. The milestone slug (`v1.0`,
 * `m2`, ...) varies per project, so this is declared as a shape, not a
 * literal path — a single path segment standing in for the slug, anchored
 * the same way `STRUCTURAL_RE_SRC`'s alternatives are (#4605).
 *
 * Mirrored verbatim into `gsd-core/workflows/pr-branch.md`'s
 * `MILESTONE_PHASES_RE="..."` assignment.
 */
export const MILESTONE_PHASES_RE_SRC = '^\\.planning/milestones/[^/]+-phases/';
