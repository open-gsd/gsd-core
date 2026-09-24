/**
 * Undo Commit Selection — issue #4661 (absorbed into epic #4906, Phase 5).
 *
 * Pure scope-matching logic for `/gsd:undo --phase N` / `--plan N-M`, replacing
 * the two hand-rolled `git log --oneline | grep -E ...` pipelines that used to
 * live in `gsd-core/workflows/undo.md`. Those greps were unanchored substring
 * matches against a live regex built from unvalidated user input — four
 * documented bug classes (see #4661):
 *
 *   1. The id was interpolated raw into an ERE: `.` and `+` are live
 *      metacharacters there, so a malformed or merely differently-shaped id
 *      silently matched the WRONG phase.
 *   2. The grep was unanchored, so a commit that only MENTIONS a scope
 *      (`docs(99-01): explain feat(03-01): commit convention`) was wrongly
 *      selected as a DECLARATION of it.
 *   3. Phase-mode's `\):` suffix and plan-mode's missing suffix disagreed on
 *      the same commit (`feat(03-01)!: breaking change`).
 *   4. The "obvious" fix — anchoring `git log --oneline`'s record start —
 *      is a trap: it silently drops `fixup! ...` / `Revert "..."` wrapper
 *      commits (a worse failure, a silent partial revert) and returns zero
 *      matches under `color.ui=always` (ANSI codes precede the sha).
 *
 * This module closes all four by parsing each commit subject through the
 * SAME anchored conventional-commit grammar the changelog/PR-title gate uses
 * (`HEADER_RE`, reused verbatim from `scripts/release-notes/conventional-title.cjs`
 * — see the require() below), then comparing the extracted scope to the
 * caller-supplied target id by exact STRING EQUALITY. No regex is built from
 * user input at any point past `validatePhaseNumber` (src/security.cts),
 * which the CLI caller (`gsd-tools.cjs query select-revert-commits`) runs
 * BEFORE this module ever sees the id.
 *
 * Deliberately no `fs`/`child_process` in this file: it operates purely on
 * `{sha, subject}` records the caller already fetched (e.g. via `git log
 * --format=%H%x00%s`), so it is unit-testable without touching git or the
 * filesystem.
 *
 * KNOWN LIMIT (documented, not a defect): `unwrapSubject` unwraps ONE level
 * of a `fixup! `/`squash! `/`Revert "..."` wrapper. A doubly-wrapped subject
 * (e.g. `Revert "fixup! feat(03-01): work"`) is treated as unparseable (no
 * declared scope) after that single unwrap — it is NOT selected, never
 * mis-selected. This bounds the module to the wrapper shapes git itself
 * produces (`fixup!`/`squash!` from `--fixup`/`--squash`, `Revert "..."` from
 * `git revert`), each of which wraps a single ordinary commit subject, not
 * another wrapper.
 */

import path from 'node:path';

// Reuse the exact HEADER_RE the changelog classifier and PR-title CI gate
// already depend on (#1549) — never fork a second copy of this grammar. A
// bare `require()` (not a TS `import ... = require(...)`) is used
// deliberately: `scripts/` sits outside this build's `rootDir` ("src", see
// tsconfig.build.json) and carries no `.d.ts`, so a type-checked import-equals
// would fail module resolution (TS7016) under `strict`/`noImplicitAny`. A
// plain `require()` resolves through Node's ambient `NodeRequire` type
// (`(id: string) => any`) instead, sidestepping that check entirely — the
// cast below is the only place the resulting shape is asserted.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const conventionalTitle = require(
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'release-notes', 'conventional-title.cjs'),
) as { HEADER_RE: RegExp };

const { HEADER_RE } = conventionalTitle;

// ─── Types ────────────────────────────────────────────────────────────────

export interface CommitRecord {
  sha: string;
  subject: string;
}

export interface ClassifiedCommit {
  sha: string;
  subject: string;
  /** The raw scope text (parens stripped), or null if none was declared/parseable. */
  parsedScope: string | null;
  matched: boolean;
}

export interface ScopeSelectionResult {
  selected: CommitRecord[];
  classified: ClassifiedCommit[];
}

/**
 * `'phase'` mode additionally accepts a scope of the form `<targetId>-<rest>`
 * (a plan-scoped commit belonging to the target phase), matching the
 * tolerance the old `\(0*${TARGET_PHASE}(-[0-9]+)?\):` grep had for phase
 * mode. `'plan'` mode is exact-match only.
 */
export type SelectionMode = 'phase' | 'plan';

// ─── Subject unwrapping (Known limit: exactly ONE level) ──────────────────

const FIXUP_PREFIX = 'fixup! ';
const SQUASH_PREFIX = 'squash! ';
const REVERT_RE = /^Revert "(.*)"$/;

/**
 * Strip exactly one `fixup! `/`squash! `/`Revert "..."` wrapper layer off a
 * commit subject, returning the (possibly) unwrapped remainder. Never
 * recurses — a doubly-wrapped subject is returned with only its outermost
 * layer removed, which is intentionally still unparseable by `HEADER_RE` (see
 * module doc comment).
 */
function unwrapSubject(subject: string): string {
  if (subject.startsWith(FIXUP_PREFIX)) return subject.slice(FIXUP_PREFIX.length);
  if (subject.startsWith(SQUASH_PREFIX)) return subject.slice(SQUASH_PREFIX.length);
  const revertMatch = REVERT_RE.exec(subject);
  if (revertMatch) return revertMatch[1];
  return subject;
}

/**
 * Parse a (possibly wrapped) commit subject into its declared conventional-
 * commit scope, or `null` when the subject carries no parseable scope: no
 * clean `type[(scope)][!]:` header at all, or a header with no `(scope)`
 * group. Never regex-matches against untrusted `targetId` — this function
 * only ever consumes the commit's OWN subject text.
 */
function parseDeclaredScope(subject: string): string | null {
  const unwrapped = unwrapSubject(subject);
  const m = HEADER_RE.exec(unwrapped);
  if (!m) return null;
  const scopeWithParens = m[2]; // e.g. "(03-01)" — includes parens, or undefined
  if (!scopeWithParens) return null;
  // HEADER_RE's scope group is `\([^)]*\)` — always at least the two paren
  // characters when present, so slicing them off is safe unconditionally.
  return scopeWithParens.slice(1, -1);
}

/**
 * Select commits whose DECLARED conventional-commit scope identifies
 * `targetId`, by exact string equality (`'plan'` mode) or exact-or-phase-
 * prefixed equality (`'phase'` mode). `targetId` is assumed ALREADY
 * VALIDATED/NORMALIZED by the caller (e.g. via `validatePhaseNumber` from
 * `src/security.cts`) — this function performs no validation of its own, and
 * never builds a regex from it (string equality / `startsWith` only), so a
 * malformed or metacharacter-laden `targetId` cannot cause a wildcard-style
 * over-match the way the retired grep pipelines could.
 */
export function selectCommitsByDeclaredScope(
  commits: CommitRecord[],
  targetId: string,
  mode: SelectionMode = 'plan',
): ScopeSelectionResult {
  const phasePrefix = `${targetId}-`;
  const classified: ClassifiedCommit[] = commits.map(({ sha, subject }) => {
    const parsedScope = parseDeclaredScope(subject);
    let matched = false;
    if (parsedScope !== null) {
      matched = mode === 'phase'
        ? parsedScope === targetId || parsedScope.startsWith(phasePrefix)
        : parsedScope === targetId;
    }
    return { sha, subject, parsedScope, matched };
  });
  const selected = classified
    .filter((c) => c.matched)
    .map(({ sha, subject }) => ({ sha, subject }));
  return { selected, classified };
}
