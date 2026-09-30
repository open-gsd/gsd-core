/**
 * Verification Status — single queryable home for verification-status routing.
 *
 * Issue #651: consolidate the pass/gaps_found/human_needed routing that was
 * previously scattered across ship.md and execute-phase.md into a single
 * tested module. Both workflow files will later consume this module's routing
 * table as the single source of truth.
 *
 * ADR-457 build-at-publish: source in src/verification.cts, compiled to
 * gsd-core/bin/lib/verification.cjs (gitignored).
 *
 * DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix: status extraction is scoped to
 * the leading YAML frontmatter block only. A `status:` line in the body (e.g.
 * inside a fenced code block) is ignored — this is the exact failure mode that
 * issue #586 / PR #650 identified. The shared extractFrontmatter parser anchors
 * its regex at byte 0 of the document, which provides this guarantee.
 *
 * #2348 staleness signal: whether a *-VERIFICATION.md is stale (a summary newer
 * than it) is decided from git commit time when a file is committed AND clean,
 * and from filesystem mtime otherwise. mtimes are assigned at checkout time and
 * are not preserved by `git clone` / `cp -R`, and any unrelated `touch` /
 * reformat / editor-save re-stales a valid report — so a committed phase could
 * read `passed` on one machine and `stale` on a fresh clone purely from checkout
 * order. Git commit time is content-tied and clone-stable; mtime is retained
 * only for uncommitted or working-tree-dirty files, where it is the true
 * last-changed signal. Both are real wall-clock change times, so the comparison
 * is sound even when one file uses each.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot } from './project-root.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseId = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import scanPhasePlans = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScopeMod = require('./planning-scope.cjs');
import { execGit } from './shell-command-projection.cjs';
import { formatGsdSlash, resolveRuntime } from './runtime-slash.cjs';
import { isContainedIn, requireSafePath, PathAcceptance } from './security.cjs';
import { escapeRegex } from './pattern.cjs';
import { tokenizeHeadings, collectSection } from './markdown-sectionizer.cjs';
import { parseMarkdownTable } from './markdown-table.cjs';
import { parseNamedArgsOrExit } from './command-arg-projection.cjs';

const { output, error } = io;
const { extractPhaseToken, scopeToPhase } = phaseId;
const { extractFrontmatter, FRONTMATTER_UNPARSEABLE } = frontmatterMod;
const { normalizeLineEndings } = coreUtilsMod;
const { SCOPE } = planningScopeMod;
type Scope = planningScopeMod.Scope;

// ─── The closed VerificationStatus enum (#5118, ADR-5057 §1 / Phase 4) ────────

/**
 * The closed verification-status vocabulary. This module is its ONE owner:
 * every other `src/` site imports `VERIFICATION_STATUS` / `VerificationStatus`
 * (the ESLint rule `local/no-verification-status-literal` keeps a spelled
 * literal out of `src/`), every workflow reads the owner's query fields, and
 * the prose writer contract (`agents/gsd-verifier.md`,
 * `templates/verification-report.md`) is parity-locked to `VERIFIER_STATUSES`.
 *
 * `unknown` is not a member (#5118): it existed only to pass an out-of-set
 * report value along (#4817's `status: verified` → `/gsd-execute-phase`). An
 * out-of-set report value is now a `VerificationStatusError`, thrown where it
 * is read.
 *
 * Reader-only members — never valid in a report's frontmatter:
 *   - `stale`               the covered inputs moved after the verifier ran
 *   - `missing`             the phase directory exists and holds no report, or
 *                           the report has no `status` (the verify step never ran)
 *   - `unparseable`         the report exists but its frontmatter is not YAML
 *                           (#4806) — this one meaning only
 *   - `phase_dir_not_found` there was no phase directory to look in (ADR-5057
 *                           amendment 2, #4987) — a usage error, never
 *                           `execute-phase`
 *
 * An out-of-set report status is NOT a member either: the reader throws, and
 * `isPhaseComplete`'s no-throw projection of it is `status: null` with scope
 * UNREADABLE and `statusError` set (never `unparseable`).
 */
const VERIFICATION_STATUS = Object.freeze({
  PASSED: 'passed',
  GAPS_FOUND: 'gaps_found',
  HUMAN_NEEDED: 'human_needed',
  STALE: 'stale',
  MISSING: 'missing',
  UNPARSEABLE: 'unparseable',
  PHASE_DIR_NOT_FOUND: 'phase_dir_not_found',
} as const);

type VerificationStatus = typeof VERIFICATION_STATUS[keyof typeof VERIFICATION_STATUS];

/** The writer contract: the only values a report's frontmatter `status` may carry. */
type VerifierStatus =
  | typeof VERIFICATION_STATUS.PASSED
  | typeof VERIFICATION_STATUS.GAPS_FOUND
  | typeof VERIFICATION_STATUS.HUMAN_NEEDED;

/** The set of status values the gsd-verifier agent writes — a frozen subset of the enum. */
const VERIFIER_STATUSES: ReadonlySet<VerifierStatus> = Object.freeze(new Set<VerifierStatus>([
  VERIFICATION_STATUS.PASSED,
  VERIFICATION_STATUS.GAPS_FOUND,
  VERIFICATION_STATUS.HUMAN_NEEDED,
]));

const VERIFICATION_STATUS_VALUES: ReadonlySet<string> = new Set<string>(Object.values(VERIFICATION_STATUS));

/** True exactly when `v` is a member of the closed enum (exact match, no case folding). */
function isVerificationStatus(v: unknown): v is VerificationStatus {
  return typeof v === 'string' && VERIFICATION_STATUS_VALUES.has(v);
}

/**
 * Fail where the value is produced (the same rule as phase-status.cts's
 * `assertPhaseStatus`): a non-member is a `TypeError` naming the call site.
 */
function assertVerificationStatus(v: unknown, where: string): asserts v is VerificationStatus {
  if (!isVerificationStatus(v)) {
    throw new TypeError(
      `${where}: ${describeRawStatus(v)} is not a VerificationStatus (expected one of ${[...VERIFICATION_STATUS_VALUES].join(', ')})`,
    );
  }
}

/** The rendered raw-status token is cut to this many characters (#5118 security review). */
const RAW_STATUS_TOKEN_LIMIT = 120;

/**
 * Render an untrusted status value as one quoted, control-free token
 * (io.formatDiagnosticToken escapes C0/C1 controls, line/paragraph
 * separators, zero-width and bidi-override characters and the BOM as
 * `\uXXXX`), truncated to RAW_STATUS_TOKEN_LIMIT characters plus
 * `…(N more)` — a report is agent-written text, and its echo reaches every
 * workflow's LLM context through the error message.
 */
function describeRawStatus(raw: unknown): string {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    let json: string | undefined;
    try {
      json = JSON.stringify(raw);
    } catch {
      json = undefined;
    }
    text = json ?? String(raw);
  }
  const rendered = io.formatDiagnosticToken(text);
  if (rendered.length <= RAW_STATUS_TOKEN_LIMIT) return rendered;
  // The cut must land on a boundary: never inside a `\uXXXX` escape the
  // formatter emitted (a fragment such as `\u00` would read as a different
  // character) and never between the halves of a surrogate pair (a lone
  // surrogate is not valid text). Back off to the start of either.
  let cut = RAW_STATUS_TOKEN_LIMIT;
  const partialEscape = /\\u[0-9a-fA-F]{0,3}$/.exec(rendered.slice(0, cut));
  if (partialEscape) {
    cut -= partialEscape[0].length;
  } else {
    const last = rendered.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  }
  return `${rendered.slice(0, cut)}…(${rendered.length - cut} more)`;
}

/** `VerificationStatusError.code` — import this constant wherever the code is matched. */
const VERIFICATION_STATUS_ERROR_CODE = 'ERR_VERIFICATION_STATUS_OUT_OF_SET';

/**
 * A report whose frontmatter `status` is outside the writer set
 * (`VERIFIER_STATUSES`) — a string that is not a member (`verified`, `Passed`,
 * a reader-only member such as `stale`), or a non-string value (`5`, `true`,
 * a list). Thrown by the reader, never folded into another status (#4817).
 *
 * It carries its own ERROR_REASON (`reason`, `verification_status_invalid`) —
 * the one owner of that mapping: a CLI surface fails with `error(err.message,
 * err.reason)`, and the command-routing hub returns it as a pure Result whose
 * `kind` is that reason. `isPhaseComplete` maps it to its UNREADABLE scope
 * (`status: null`, `statusError`) so its no-throw contract holds.
 */
class VerificationStatusError extends Error {
  readonly code = VERIFICATION_STATUS_ERROR_CODE;
  readonly reason = io.ERROR_REASON.VERIFICATION_STATUS_INVALID;
  readonly rawStatus: unknown;
  readonly file: string;
  readonly accepted: readonly VerifierStatus[];

  constructor(rawStatus: unknown, file: string) {
    const accepted = [...VERIFIER_STATUSES];
    super(
      `Verification report ${io.formatDiagnosticToken(file)} has status ${describeRawStatus(rawStatus)}, ` +
      `which is outside the closed set — accepted values: ${accepted.join(' | ')}. ` +
      `Recovery: set the report's frontmatter \`status:\` to one of ${accepted.join(' | ')}, ` +
      "or delete the report and re-run the phase's verification.",
    );
    this.name = 'VerificationStatusError';
    this.rawStatus = rawStatus;
    this.file = file;
    this.accepted = accepted;
  }
}

/**
 * The CLI projection of a VerificationStatusError — its own message and its
 * own `.reason` (the one owner of the reason mapping). Every CLI surface that
 * refuses a report (a thrown error at the entry seam, or an aggregate
 * carrying one in its result) fails through here; nothing restates the reason.
 */
function failOnVerificationStatusError(err: VerificationStatusError): never {
  return error(err.message, err.reason);
}

/**
 * The carry rule every aggregate shares: the FIRST refused report is the one
 * an aggregate fails with. Keeps `carried` once set; otherwise takes
 * `candidate` (a later report never displaces an earlier one).
 */
function firstStatusError<E extends VerificationStatusError>(
  carried: E | null | undefined,
  candidate: E | null | undefined,
): E | undefined {
  return carried ?? candidate ?? undefined;
}

/**
 * The owner's frontmatter-only judgement of a report's `status` — the one
 * place a VERIFICATION report's `status` scalar is read (#5118: phase.cts,
 * audit.cts and uat-predicate.cts used to read it themselves). Returns the
 * writer-set member, or `null` when the report carries no status (absent key,
 * `null`, an empty string, or an unparseable block — the caller routes
 * those). Throws `VerificationStatusError` for anything else, including a
 * non-string value.
 *
 * `fm` is `extractFrontmatter`'s result for the report at `filePath`.
 */
function reportStatusOf(fm: Record<string, unknown>, filePath: string): VerifierStatus | null {
  if ((fm as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true) return null;
  const raw = fm['status'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if ((VERIFIER_STATUSES as ReadonlySet<string>).has(trimmed)) return trimmed as VerifierStatus;
    throw new VerificationStatusError(trimmed, filePath);
  }
  throw new VerificationStatusError(raw, filePath);
}

// ─── The one routing table ─────────────────────────────────────────────────────

type RouteCommand = '' | 'execute-phase' | 'plan-phase' | 'verify-work';

interface VerificationRoute {
  next_action: string;
  /** BARE command name (#2617) — projected per runtime by `routeResult`. */
  command: RouteCommand;
  /** Argument tail appended after the phase number (`gaps_found`'s ` --gaps`). */
  tail: '' | ' --gaps';
}

/**
 * VERIFICATION_ROUTES — the one routing table (#5118). Keyed by exactly the
 * enum (`Record<VerificationStatus, …>`: a missing or extra key is a compile
 * error); the key IS the status, so entries carry no `status` field. Every
 * result `readVerificationStatus` returns is projected from this table by
 * `routeResult` — no return site hard-codes a command.
 *
 * #2617: `command` holds a BARE command name (`execute-phase`), never a
 * prefixed one; `routeResult` projects it through `formatGsdSlash` with the
 * caller's runtime, so Codex sees `$gsd-execute-phase` and slash-hyphen
 * runtimes see `/gsd-execute-phase`.
 *
 * `stale` has ONE route: `execute-phase`. Its regenerating action is the
 * shared step `gsd-core/workflows/execute-phase/steps/verify-phase-goal.md`
 * (execute-phase's verify_phase_goal, which verify-work's stale arm includes
 * too): it re-runs the verifier, which regenerates VERIFICATION.md and its
 * digest (#4682, #4887).
 */
const VERIFICATION_ROUTES: Readonly<Record<VerificationStatus, Readonly<VerificationRoute>>> = Object.freeze({
  passed: Object.freeze<VerificationRoute>({
    next_action: 'Verification passed — continue.',
    command: '',
    tail: '',
  }),
  gaps_found: Object.freeze<VerificationRoute>({
    next_action: 'Gaps found. Plan the fixes, then re-run execute-phase before shipping.',
    command: 'plan-phase',
    tail: ' --gaps',
  }),
  human_needed: Object.freeze<VerificationRoute>({
    next_action: "Human verification required. Complete the manual tests in the phase's *-UAT.md, then re-run the verify step until status is passed.",
    // #2617: init's projector and this table used to disagree on whether a
    // next command existed at all; `verify-work <N>` is the useful answer.
    command: 'verify-work',
    tail: '',
  }),
  stale: Object.freeze<VerificationRoute>({
    // #4682 / #5118: the only remedy for a stale report is re-running the
    // verifier; /gsd-verify-work on its own never rewrites VERIFICATION.md.
    next_action: 'Verification is stale — covered source files changed after the verifier last ran. Re-run execute-phase for this phase: it resumes at the verification gates and re-runs the verifier, regenerating VERIFICATION.md and its digest. verify-work alone cannot refresh a stale report.',
    command: 'execute-phase',
    tail: '',
  }),
  // The phase directory exists and holds no report, or the report has no
  // `status`: the verify step never completed (#2868).
  missing: Object.freeze<VerificationRoute>({
    next_action: 'No verification report found — the verify step never completed. Running execute-phase is safe here: it resumes at the verification gates and does not re-run plans that already have a SUMMARY.md (see #2868).',
    command: 'execute-phase',
    tail: '',
  }),
  // #4806: the report EXISTS but its frontmatter is not parseable YAML —
  // re-running execute-phase cannot fix a YAML typo in an existing report.
  unparseable: Object.freeze<VerificationRoute>({
    next_action: "The *-VERIFICATION.md frontmatter is not parseable YAML — fix the syntax error in the report itself. Re-running execute-phase cannot fix a YAML typo in an existing report.",
    command: '',
    tail: '',
  }),
  // ADR-5057 amendment 2 / #4987: there was nothing to look in — a usage
  // error, never execute-phase (which would re-run a phase that may already be
  // archived under .planning/milestones/).
  phase_dir_not_found: Object.freeze<VerificationRoute>({
    next_action: 'Usage error: the phase directory does not exist — pass an existing phase directory (resolve it with find-phase; phases archived by complete-milestone live under .planning/milestones/v<X.Y>-phases/).',
    command: '',
    tail: '',
  }),
});

/**
 * Project a BARE command name (plus optional argument tail) into the surface the
 * given runtime actually installs (#2617).
 *
 * `formatGsdSlash` owns the per-runtime shape (`$gsd-<cmd>` for shell-var
 * runtimes like Codex, `/gsd-<cmd>` otherwise) and is idempotent, so passing an
 * already-prefixed string is safe. An empty command stays empty — "no next
 * command" must not become a bare prefix.
 */
function projectNextCommand(bare: string, runtime: string, tail = ''): string {
  if (!bare) return '';
  return `${formatGsdSlash(bare, runtime) as string}${tail}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FsLike {
  readdirSync(dir: string): string[];
  readFileSync(filePath: string, encoding: 'utf-8'): string;
  /**
   * #5118: `isDirectory` lets the reader tell "no phase directory at this path"
   * (`phase_dir_not_found`) from "a directory with no report" (`missing`).
   */
  statSync(filePath: string): { mtimeMs: number; isFile(): boolean; isDirectory(): boolean };
}

/**
 * Real `node:fs`-backed default satisfying FsLike. Every method wraps a call
 * to `fs.<method>` rather than capturing the function reference — existing
 * tests mock individual `fs` methods in place (`t.mock.method(fs, 'statSync', …)`),
 * and a captured reference taken at module-load time would be invisible to
 * that late mock, silently un-mocking this seam's "default" path.
 */
const defaultFsImpl: FsLike = {
  readdirSync: (dir: string) => fs.readdirSync(dir),
  readFileSync: (filePath: string, encoding: 'utf-8') => fs.readFileSync(filePath, encoding),
  statSync: (filePath: string) => fs.statSync(filePath),
};

/**
 * Outcome of a staleness check. `determined:false` means the check could NOT
 * run to completion (an fs / scanPhasePlans / injected-clock failure) — this
 * is distinct from `determined:true, stale:false`, which means the check ran
 * to completion and genuinely found nothing stale. Collapsing the two (the
 * pre-#3057 behavior: both returned `null`) let a disk-scan failure silently
 * report "not stale" — the same fail-open shape as #3050. (#3057 B3)
 */
type StaleCheckResult =
  | { determined: true; stale: true; verificationFile: string; summaryFile: string }
  | { determined: true; stale: false }
  | { determined: false };

/**
 * Resolve the git commit time (epoch-ms) for each of `files` (paths relative to
 * `phaseDir`) that is BOTH committed AND clean (its working-tree content matches
 * HEAD), keyed by the given relative path. A file that is dirty, untracked,
 * uncommitted, or in a non-repo is simply absent — callers then time it by its
 * filesystem mtime. Injectable so tests exercise the clock without git. (#2348)
 */
type PhaseCleanCommitTimesFn = (phaseDir: string, files: string[]) => Map<string, number>;

/** Normalize separators to posix (git emits `/`; callers may pass `\` on Windows). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * #4155: canonicalize a covered-input path before it becomes either a
 * dedup/sort/hash key or a confinement-check subject. `path.posix.normalize`
 * collapses `./`, redundant slashes, and internal `..` segments (`a/../../b`
 * → `../b`) — without this, two spellings of the SAME file (`src/x.cts` vs
 * `./src/x.cts`) hash as different covered inputs (spurious `stale`, or a
 * file double-counted into the digest under two keys), and an escape
 * disguised by an internal `..` segment slips past a check that only looks
 * at the string's start.
 */
function normalizeRel(p: string): string {
  return path.posix.normalize(toPosix(p));
}

/**
 * Canonicalize a covered-files list: normalize, de-duplicate, sort — the SAME
 * transform computeCoveredDigest and cmdVerificationFingerprint both need
 * (the digest's own key order; the CLI's own `covered_files` JSON output).
 *
 * #5095 (ADR-5057 Phase 2): `opts.version >= 3` additionally drops any
 * report-shaped path (`isVerificationReportPath`) — a report is never an
 * input to its own digest (#4857). Versionless callers (the default) keep
 * the pre-#5095 behaviour: normalize/dedupe/sort only, no filtering.
 */
function canonicalizeCoveredFiles(files: readonly string[], opts: { version?: number } = {}): string[] {
  const normalized = files.map(normalizeRel);
  const filtered = opts.version !== undefined && opts.version >= 3
    ? normalized.filter((f) => !isVerificationReportPath(f))
    : normalized;
  return Array.from(new Set(filtered)).sort();
}

/**
 * #5095 (ADR-5057 Phase 2, #4857): a covered-input path names a verification
 * REPORT — basename `VERIFICATION.md` or ending `-VERIFICATION.md`
 * (case-sensitive, as `resolveVerificationFile` is) — as opposed to any other
 * evidence. `computeCoveredDigest(projectRoot, coveredFiles)` never receives
 * the report's OWN path as a distinguished value — the report writes its own
 * digest into its own frontmatter, so a comparison inside that function is
 * structurally impossible (it would need to know, while computing a value,
 * what that value is about to become). The filter therefore lives here, one
 * function up from the digest, as a PATTERN match on shape, not a path
 * identity check. Matches `docs/VERIFICATION.md` (same basename) but not
 * `VERIFICATION-NOTES.md` or `07-VERIFICATION.md.bak` (different basename).
 */
function isVerificationReportPath(rel: string): boolean {
  const basename = path.posix.basename(toPosix(rel));
  return basename === 'VERIFICATION.md' || basename.endsWith('-VERIFICATION.md');
}

/**
 * #5095 (ADR-5057 Phase 2, amendment 1 / R4, revised R7): the real filesystem
 * scopes a covered-input path may be confined to. `realRoot` is the checkout
 * itself. `planningScopes` is every ANCHORED planning scope the Planning
 * Workspace Module's layout admits (`planning-workspace.cts`'s
 * `planningDir`: `.planning`, `.planning/<project>`,
 * `.planning/workstreams/<ws>`, `.planning/<project>/workstreams/<ws>`) —
 * derived from the PROJECT ROOT alone, NEVER from a caller's `phaseDir`, so a
 * symlinked `.planning/workstreams/<ws>/phases`, `.planning/<project>/phases`,
 * or the whole `.planning/<project>` / `.planning/workstreams/<ws>` scope
 * maps its artifacts to that scope's OWN spelling — never collapsing onto, or
 * being dropped from, the top-level `.planning/phases/<phase>/…` shape the
 * pre-R7 single scope root only recognised (see `enumeratePlanningScopes`
 * for the enumeration and its security refusal of a dangerous scope root).
 * Each scope carries its lexical, project-root-relative spelling (`lexRel`,
 * posix) and its realpath (`real`, `null` when the directory does not exist
 * or was refused). Real `fs.realpathSync` throughout — never the
 * caller-injected `FsLike` seam (see computeCoveredDigest's own doc for why:
 * these are trusted anchors the caller derived, not attacker-influenced
 * covered-input data).
 */
interface PlanningScope {
  /** Project-root-relative, posix-normalized spelling, e.g. `.planning/workstreams/ws1`. */
  lexRel: string;
  /** Realpath of `lexRel`, or `null` when it does not exist or was refused as dangerous. */
  real: string | null;
}

interface ContainmentRoots {
  realRoot: string | null;
  planningScopes: PlanningScope[];
}

/**
 * #5095 (R7): enumerate every anchored planning scope the Planning Workspace
 * Module's layout admits, by walking the REAL directory tree rooted at
 * `<projectRoot>/.planning` — never the caller's `phaseDir` (the pre-R7 bug:
 * admitting a scope root on `basename(phaseDir's parent) === 'phases'` alone
 * made any directory named `phases` anywhere an admissible root). Only
 * directories are admitted, and a project/workstream segment failing
 * `planningDir`'s own `BAD_SEGMENT` rule (a path separator or `..`) is
 * skipped — the identical validation `planningDir` itself enforces, so every
 * scope this function admits is one `planningDir` could also resolve to.
 * `workstreams` is reserved as a layout segment (never itself a project
 * name), so the walk cannot derive the same scope twice under two labels.
 * Each planning BASE contributes two scopes — the base itself, and its own
 * `phases/` subdirectory — since `phases/` may be independently symlinked to
 * a per-project/per-workstream store while the base directory stays real
 * (the #4894 layout, generalized to every base shape); the longest-`lexRel`
 * -wins rule in `mapRealPathToRootRelative` / `bestPlanningScopeForRel` then
 * prefers the `phases` scope for anything living under it.
 *
 * Security: a scope whose realpath is the filesystem root, or an ANCESTOR of
 * `realRoot` itself, is refused outright (`real: null`) — an
 * attacker-controlled `.planning -> /` (or `-> ..`) symlink must never become
 * an admissible containment root.
 */

function enumeratePlanningScopes(projectRoot: string, realRoot: string | null): PlanningScope[] {
  const BAD_SEGMENT = /[/\\]|\.\./;
  const listDirs = (dirAbs: string): string[] => {
    try {
      return fs
        .readdirSync(dirAbs, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !BAD_SEGMENT.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  const realOf = (p: string): string | null => {
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      return null;
    }
    if (path.dirname(real) === real) return null; // filesystem root
    if (realRoot !== null && real !== realRoot && isContainedIn(realRoot, real)) return null; // ancestor of realRoot
    return real;
  };

  // Every planning BASE (a directory `planningDir` itself would resolve to)
  // contributes TWO scopes: the base itself (for a direct child like
  // `ROADMAP.md`/`config.json`) and its OWN `phases/` subdirectory (for phase
  // artifacts) — kept separate because `phases/` may be independently
  // symlinked to a per-project/per-workstream store while the base directory
  // stays real (the #4894 layout, generalized to every base shape). The
  // longest-`lexRel`-wins rule elsewhere then prefers the `phases` scope for
  // anything under it.
  const addBase = (lexRel: string, baseAbs: string): void => {
    scopes.push({ lexRel, real: realOf(baseAbs) });
    scopes.push({ lexRel: `${lexRel}/phases`, real: realOf(path.join(baseAbs, 'phases')) });
  };

  const scopes: PlanningScope[] = [];
  const planningAbs = path.join(projectRoot, '.planning');
  const planningBaseReal = realOf(planningAbs);
  scopes.push({ lexRel: '.planning', real: planningBaseReal });
  scopes.push({ lexRel: '.planning/phases', real: realOf(path.join(planningAbs, 'phases')) });

  // #5095 (R7(c) follow-up, security): when `.planning` itself was refused as
  // a dangerous root (filesystem root, or an ancestor of `realRoot` — see
  // `realOf` above), NEVER walk its `workstreams`/project subdirectories to
  // mint further scopes. `listDirs`/`path.join` operate on the LEXICAL,
  // still-symlinked `planningAbs`, so with `.planning -> /` every entry of
  // the real filesystem root (`/etc`, `/usr`, ...) would otherwise surface as
  // an admissible `.planning/<project>` scope — legitimizing an attacker- or
  // container-controlled root-filesystem directory as a containment root the
  // instant it happens to share a name with something reachable from `/`.
  // Each such child is realpath-resolved on its OWN merits (not an ancestor
  // of `realRoot`, not the filesystem root itself), so it silently passes the
  // per-scope refusal check even though its only claim to legitimacy is
  // having been discovered by listing a root the outer check already
  // rejected. Refusing to enumerate here is what makes that refusal actually
  // stick.
  if (planningBaseReal === null) return scopes;

  for (const ws of listDirs(path.join(planningAbs, 'workstreams'))) {
    addBase(`.planning/workstreams/${ws}`, path.join(planningAbs, 'workstreams', ws));
  }

  for (const project of listDirs(planningAbs)) {
    if (project === 'workstreams') continue;
    const projectAbs = path.join(planningAbs, project);
    addBase(`.planning/${project}`, projectAbs);
    for (const ws of listDirs(path.join(projectAbs, 'workstreams'))) {
      addBase(`.planning/${project}/workstreams/${ws}`, path.join(projectAbs, 'workstreams', ws));
    }
  }

  return scopes;
}

function resolveContainmentRoots(projectRoot: string): ContainmentRoots {
  let realRoot: string | null;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch {
    realRoot = null;
  }
  return { realRoot, planningScopes: enumeratePlanningScopes(projectRoot, realRoot) };
}

function bestPlanningScopeForRel(rel: string, planningScopes: readonly PlanningScope[]): PlanningScope | null {
  let best: PlanningScope | null = null;
  for (const scope of planningScopes) {
    if (
      (rel === scope.lexRel || rel.startsWith(`${scope.lexRel}/`)) && // allow-handrolled-containment: lexical PREFIX selection among candidate scope spellings (posix segment-boundary), not a resolved-path containment decision — the realpath check happens separately via isContainedIn on scope.real
      (best === null || scope.lexRel.length > best.lexRel.length)
    ) {
      best = scope;
    }
  }
  return best;
}

/**
 * #5095 (R7): map an already-`realpathSync`-resolved target back to a
 * root-relative, posix-normalized spelling. The ANCHORED scope with the
 * LONGEST `lexRel` whose `real` contains the target wins — so a nested scope
 * (e.g. `.planning/workstreams/ws1`) is preferred over the top-level
 * `.planning` scope for a target reachable through both, and a
 * same-named-but-different-store phase under the nested scope is never
 * mapped onto the root scope's spelling. Falls back to a bare
 * project-root-relative path when the target lives inside `realRoot` but no
 * scope's real claims it; else `null` (fail closed — the caller must not
 * guess a spelling for a path it cannot place).
 */
function mapRealPathToRootRelative(
  real: string,
  realRoot: string,
  planningScopes: readonly PlanningScope[],
): string | null {
  let best: PlanningScope | null = null;
  for (const scope of planningScopes) {
    if (
      scope.real !== null &&
      isContainedIn(real, scope.real) &&
      (best === null || scope.lexRel.length > best.lexRel.length)
    ) {
      best = scope;
    }
  }
  if (best !== null) {
    const rel = normalizeRel(path.relative(best.real as string, real));
    return rel === '' || rel === '.' ? best.lexRel : `${best.lexRel}/${rel}`;
  }
  if (isContainedIn(real, realRoot)) {
    return normalizeRel(path.relative(realRoot, real));
  }
  return null;
}

/**
 * #5095 (R2/R3): the single owner of "which artifacts a fingerprint must
 * cover" — every live `*-PLAN.md`/`*-SUMMARY.md` in `phaseDir`
 * (`scanPhasePlans`'s `allPlanFiles` + `summaryFiles`, BEFORE the
 * `status:superseded` exclusion — row 17: a superseded plan still needs a
 * matching digest entry, the same set `allCurrentArtifactsCovered` checks),
 * minus anything report-shaped (R3: a plan-scan match that is ALSO
 * report-shaped, e.g. `07-PLAN-01-VERIFICATION.md`, must never enter the
 * covered set on either side). Each surviving candidate is realpath-resolved
 * and mapped back to a root-relative spelling via `mapRealPathToRootRelative`
 * — NEVER a literal `../`-relative path — so the #4894 `--project-dir` shape
 * (the phase directory passed as its OWN real path, inside an out-of-repo
 * store) still produces sensible `.planning/…` covered_files.
 *
 * Fails closed: an incomplete/unreadable phase-dir scan, an unreadable
 * artifact, or an artifact whose realpath escapes both known roots make the
 * WHOLE result unusable (`{ ok: false, reason }`) — a caller must not vouch
 * for a fingerprint over a set it could not fully resolve.
 */
type PhaseArtifactPathsResult =
  | { ok: true; paths: string[]; scope: Scope; mappedPhaseDir: string | null }
  | { ok: false; reason: string };

function phaseArtifactPaths(phaseDir: string, projectRoot: string): PhaseArtifactPathsResult {
  const roots = resolveContainmentRoots(projectRoot);
  if (roots.realRoot === null) {
    return { ok: false, reason: `project root is unreadable: ${projectRoot}` };
  }
  const scan = scanPhasePlans(phaseDir) as { allPlanFiles: string[]; summaryFiles: string[]; scope: Scope };
  // Fail closed on a non-COMPLETE scan (unreadable phase dir, or an
  // unreadable nested plans/ dir) — a partial scan's invisible contents can
  // never be proven covered (mirrors allCurrentArtifactsCovered's own
  // fail-closed contract).
  if (scan.scope !== SCOPE.COMPLETE) {
    return { ok: false, reason: `phase directory scan is incomplete (scope: ${scan.scope}): ${phaseDir}` };
  }
  const candidates = [...scan.allPlanFiles, ...scan.summaryFiles].filter(
    (f) => !isVerificationReportPath(f),
  );
  const paths: string[] = [];
  for (const f of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(path.join(phaseDir, f));
    } catch {
      return { ok: false, reason: `phase artifact is unreadable: ${f}` };
    }
    const mapped = mapRealPathToRootRelative(real, roots.realRoot, roots.planningScopes);
    if (mapped === null) {
      return { ok: false, reason: `phase artifact escapes the project root: ${f}` };
    }
    paths.push(mapped);
  }
  // #5095 (R2): the phase dir's own mapped spelling, fed to `sharedRootsFor`
  // so a workstream/project ROADMAP under an out-of-repo store is still
  // recognized as a shared planning document even when `phaseDir` itself was
  // addressed by its real (non-`.planning`-spelled) path.
  let mappedPhaseDir: string | null = null;
  try {
    const realPhaseDir = fs.realpathSync(phaseDir);
    mappedPhaseDir = mapRealPathToRootRelative(realPhaseDir, roots.realRoot, roots.planningScopes);
  } catch {
    mappedPhaseDir = null;
  }
  return { ok: true, paths, scope: scan.scope, mappedPhaseDir };
}

// ─── #4155: covered-input fingerprint ──────────────────────────────────────────

/**
 * Bump on any change to the digest's input shape (path list, hashing order,
 * per-file hash algorithm) so an old stored digest can never collide with a
 * differently-computed new one — a version mismatch is just a mismatch.
 *
 * Version history:
 *   v1 (#4155) — every covered path's whole bytes, uniformly.
 *   v2 (#4623) — repo-wide planning documents (`isSharedPlanningDoc`) are
 *                excluded from the hash by construction.
 *   v3 (#5095, ADR-5057 Phase 2) — v2 PLUS: (a) report-shaped declared paths
 *                (`isVerificationReportPath`) are filtered before hashing — a
 *                report is never an input to its own digest (#4857); (b) the
 *                hashed set is the declared list UNIONED with the phase's own
 *                live `*-PLAN.md`/`*-SUMMARY.md` artifacts
 *                (`phaseArtifactPaths`), computed identically on both the
 *                emit (`cmdVerificationFingerprint`) and check
 *                (`readVerificationStatus`) sides — a plan/summary added
 *                after fingerprinting moves the digest itself, with no
 *                separate live-directory rescan needed (#4817); (c)
 *                containment additionally admits a `.planning`-spelled path
 *                whose realpath sits in one of the anchored planning scopes
 *                `resolveContainmentRoots` enumerates (`.planning`,
 *                `.planning/<project>`, `.planning/workstreams/<ws>`,
 *                `.planning/<project>/workstreams/<ws>`), covering a
 *                per-project/per-workstream store symlink (amendment 1,
 *                revised R7).
 *
 * A stored digest names its own version (`v<N>:sha256:…`), and
 * `readVerificationStatus` recomputes under the STORED version rather than
 * this constant — so bumping it does not flip every already-verified phase
 * to `stale` on upgrade. A legacy v1/v2 report keeps its own semantics
 * (shared documents included for v1; no report filter or artifact union for
 * either) until it is re-fingerprinted; only a version outside
 * `KNOWN_FINGERPRINT_VERSIONS` is unrecomputable and fails closed.
 */
const FINGERPRINT_VERSION = 3;
const KNOWN_FINGERPRINT_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * #4623: the planning roots whose DIRECT children are repo-wide planning
 * documents, as project-root-relative posix paths. Always `.planning`; plus
 * the phase's OWN planning root when a phase directory is known — the parent
 * of its `phases/` directory, which is how `planningDir` lays out every
 * scope (`.planning`, `.planning/<project>`, `.planning/workstreams/<ws>`,
 * `.planning/<project>/workstreams/<ws>`; `planning-workspace.cts`). Derived
 * from the phase's position rather than from a list of layouts so a
 * workstream-scoped `ROADMAP.md` is recognised without this function
 * knowing what a workstream is, and so `.planning/research/notes.md` is
 * NOT mistaken for one — lexically the two are indistinguishable from
 * `.planning/<project>/ROADMAP.md`. A phase directory that does not sit
 * under the project root (unit fixtures at a bare tmpdir) contributes no
 * extra root.
 */
function sharedPlanningRoots(projectRoot: string, phaseDir?: string | null): string[] {
  const roots = ['.planning'];
  if (phaseDir) {
    const phasesDir = path.dirname(path.resolve(phaseDir));
    const planningDir = path.dirname(phasesDir);
    const rel = normalizeRel(path.relative(path.resolve(projectRoot), planningDir));
    // Two structural checks, both load-bearing: the phase dir's PARENT must be
    // the `phases/` directory `planningDir` lays every scope out with, and the
    // derived root must sit inside `.planning/`. Without them any accepted
    // directory — `<root>/src/phases/01-fake` — would nominate `src` as a
    // planning root and silently drop real implementation evidence from the
    // digest (found by the cross-AI review of this change). A shape that fails
    // either check contributes no extra root; `.planning` itself is already
    // present.
    if (
      path.basename(phasesDir) === 'phases' &&
      rel.startsWith('.planning/') &&
      !rel.includes('/../') &&
      !roots.includes(rel)
    ) {
      roots.push(rel);
    }
  }
  return roots;
}

/**
 * #4623: a covered path names a repo-wide planning document when it sits
 * DIRECTLY under one of `sharedPlanningRoots` — `ROADMAP.md`,
 * `REQUIREMENTS.md`, `STATE.md`, `PROJECT.md`, `MILESTONES.md`,
 * `config.json`, … — as opposed to a phase's own artifacts under
 * `<root>/phases/<phase>/` or a research note under `.planning/research/`.
 * Every phase rewrites these as ordinary bookkeeping (a roadmap checkbox, a
 * requirement's traceability cell, STATE.md's position), so hashing their
 * whole bytes into one phase's digest coupled every phase's staleness to
 * every other phase's close — and to its OWN close, since `phase.complete`
 * and `requirements mark-complete` write them after the verifier has
 * already run.
 *
 * Defined by position, not by a name list, so the set cannot drift as new
 * top-level planning documents appear (the tree already carries a dozen).
 * `rel` is expected posix-normalized (`canonicalizeCoveredFiles`), so a
 * `./.planning/ROADMAP.md` spelling has already collapsed to the bare form.
 */
function isSharedPlanningDoc(rel: string, roots: readonly string[] = ['.planning']): boolean {
  if (rel === '' || rel.endsWith('/')) return false;
  return roots.includes(path.posix.dirname(rel));
}

/**
 * #5095 (R2): `sharedPlanningRoots` extended with the phase's own MAPPED
 * (root-relative, posix) directory when one is available —
 * `phaseArtifactPaths`'s `mappedPhaseDir` — so a workstream/project ROADMAP
 * under an out-of-repo store is still recognized as shared even when
 * `phaseDir` was addressed by its real, non-`.planning`-spelled path (the
 * #4894 `--project-dir` shape). Falls back to the existing absolute-path
 * derivation (`sharedPlanningRoots(projectRoot, phaseDir)`) when no mapped
 * spelling is available — byte-for-behaviour identical to the pre-#5095
 * seam for every caller that has no artifact-derivation step of its own.
 */
function sharedRootsFor(
  projectRoot: string,
  phaseDir: string | null | undefined,
  mappedPhaseDir: string | null,
): string[] {
  const roots = sharedPlanningRoots(projectRoot, phaseDir);
  if (mappedPhaseDir) {
    const phasesDir = path.posix.dirname(mappedPhaseDir);
    const planningDir = path.posix.dirname(phasesDir);
    if (
      path.posix.basename(phasesDir) === 'phases' &&
      (planningDir === '.planning' || planningDir.startsWith('.planning/')) &&
      !planningDir.includes('/../') &&
      !roots.includes(planningDir)
    ) {
      roots.push(planningDir);
    }
  }
  return roots;
}

/**
 * #4623: the fingerprint version a stored `covered_digest` was computed
 * under, or `null` when the prefix is absent, malformed, or names a version
 * this build cannot recompute (an unknown version is a mismatch by
 * construction — the fail-closed shape `FINGERPRINT_VERSION`'s doc promises).
 */
function parseFingerprintVersion(digest: string): number | null {
  const m = /^v(\d+):sha256:/.exec(digest);
  if (!m) return null;
  const version = Number(m[1]);
  return KNOWN_FINGERPRINT_VERSIONS.has(version) ? version : null;
}

/**
 * #4155: recompute the deterministic content fingerprint over a verifier's
 * declared covered-input set (phase PLAN/SUMMARY, mapped requirements,
 * implementation files in the change set) and return the versioned digest
 * string, or `null` if the set cannot be resolved.
 *
 * Determinism: paths are de-duplicated and SORTED before hashing (directory
 * enumeration order is irrelevant), each path is resolved relative to
 * `projectRoot` (the absolute checkout path never enters the digest), and
 * file BYTES are hashed (mtime never enters the digest).
 *
 * NOT normalized: line endings. Unlike the report-frontmatter read (which
 * runs every VERIFICATION.md through `normalizeLineEndings`), covered-file
 * bytes are hashed exactly as they sit on disk. A covered text file checked
 * out with CRLF line endings (e.g. a Windows checkout without a `.gitattributes
 * eol=lf` rule pinning it to LF) hashes differently than the same file on an
 * LF checkout — a real cross-platform digest mismatch, not a bug, since GSD
 * installs into arbitrary user projects with no guaranteed line-ending policy.
 *

 * Fail closed: a covered path that is empty, absolute, escapes
 * `projectRoot` (`..` traversal), or cannot be read (missing, unreadable,
 * not a regular file) makes the WHOLE fingerprint unresolvable — returns
 * `null` — rather than silently hashing a partial set. Callers treat `null`
 * as stale (#4155), the same fail-closed shape #3057 B3 established for the
 * legacy mtime staleness check.
 *
 * Always reads through the REAL `node:fs`, never a caller-injected `FsLike`
 * seam — same reasoning as the root canonicalization below, extended to
 * every covered file: `covered_files` is expected to span the whole
 * `projectRoot` (implementation files under `src/`, not just `.planning/`
 * artifacts), so a caller-scoped containment wrapper narrower than
 * `projectRoot` (e.g. `planning-inspect.cts`'s `containmentEnforcingVerificationFs`,
 * confined to `.planning/`) would reject every implementation-file read and
 * report EVERY fingerprinted phase permanently `stale` regardless of actual
 * drift — the bug this comment now documents against regressing. The
 * per-file re-check a few lines below already does the real confinement
 * work — against `projectRoot` for an implementation path, and against the
 * ANCHORED planning scope `bestPlanningScopeForRel` selects for a
 * `.planning`-spelled one (`resolveContainmentRoots`'s `planningScopes`,
 * #5095 R7) — so no security property is lost by bypassing a narrower seam
 * here.
 *
 * #5095 (R7): `computeCoveredDigest` delegates to `deriveCoveredDigest`,
 * which additionally returns the exact canonical `files` set it hashed
 * over (declared ∪ the phase's own live artifacts) — the single derivation
 * both `computeCoveredDigest`'s callers and `cmdVerificationFingerprint`'s
 * emitted `covered_files` now share, closing the double-derivation race
 * window where the emitted list and the hashed set were computed by two
 * separate `phaseArtifactPaths` calls.
 */
type CoveredDigestDerivation =
  | { ok: true; digest: string | null; files: string[]; mappedPhaseDir: string | null }
  | { ok: false; reason: string };

function deriveCoveredDigest(
  projectRoot: string,
  coveredFiles: readonly string[],
  version: number = FINGERPRINT_VERSION,
  opts: { phaseDir?: string | null } = {},
): CoveredDigestDerivation {
  // #4623: `version` selects the input shape to hash under — the CURRENT
  // one for a fresh fingerprint (the CLI verb), or the STORED one when
  // `readVerificationStatus` recomputes against a report's own digest.
  // `opts.phaseDir` lets v2+ recognise the phase's own planning root
  // (`sharedPlanningRoots`); without it only `.planning/` itself is shared.
  if (!KNOWN_FINGERPRINT_VERSIONS.has(version)) return { ok: true, digest: null, files: [], mappedPhaseDir: null };

  // #5095 (R1, ADR-5057 Phase 2): for v3+ with a known phaseDir, the hashed
  // set is the declared list UNIONED with the phase's own live artifacts —
  // computed here, ONCE, on BOTH the emit and check sides, rather than
  // separately in the CLI emitter and again in here (#5095 R7: the prior
  // shape ran `phaseArtifactPaths` twice on the emit path — once in
  // `cmdVerificationFingerprint` to build the emitted `covered_files`, again
  // in here to hash — a race window where a plan/summary added between the
  // two calls could make the emitted list and the hashed set disagree). A
  // plan/summary added after fingerprinting therefore moves the digest
  // directly; `--raw` / MCP callers that write their own declared list
  // (without enumerating plans/summaries) still match, because the checker
  // adds the identical union. An artifact-resolution failure makes the WHOLE
  // fingerprint unresolvable (fail closed).
  let declared = canonicalizeCoveredFiles(coveredFiles, { version });
  let artifactMappedPhaseDir: string | null = null;
  if (version >= 3 && opts.phaseDir) {
    const artifacts = phaseArtifactPaths(opts.phaseDir, projectRoot);
    if (!artifacts.ok) return { ok: false, reason: artifacts.reason };
    artifactMappedPhaseDir = artifacts.mappedPhaseDir;
    declared = canonicalizeCoveredFiles([...declared, ...artifacts.paths], { version });
  }
  if (declared.length === 0) return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };

  const sharedRoots = version >= 2 ? sharedRootsFor(projectRoot, opts.phaseDir, artifactMappedPhaseDir) : [];
  let hashed = 0;

  // Canonicalize the roots ONCE — every candidate's realpath is checked
  // against these, not the possibly-symlinked `projectRoot`/`.planning`
  // arguments themselves. Always via the REAL fs, never fsImpl: `projectRoot`
  // is a trusted anchor the CALLER derived (resolveProjectRoot), not
  // attacker-influenced covered-input data — routing it through a
  // caller-scoped containment seam (e.g. #4155's
  // containmentEnforcingVerificationFs, confined to `.planning/`, a proper
  // SUBSET of `projectRoot`) would reject the root itself and fail every
  // lookup regardless of whether the covered files are legitimate.
  const roots = resolveContainmentRoots(projectRoot);
  if (roots.realRoot === null) return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };

  const parts: string[] = [];
  for (const rel of declared) {
    // `normalizeRel` (already applied by `canonicalizeCoveredFiles` above)
    // collapses internal `..` segments before `rel` ever reaches here
    // (`a/../../b` → `../b`), so this start-of-string check is already the
    // full lexical confinement test — no separate post-`path.resolve`
    // re-check can observe a different answer.
    if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };
    }
    // #5095 (R7): a `.planning`-spelled path may resolve inside the checkout
    // root OR the LONGEST-prefix anchored planning scope that claims it
    // (`bestPlanningScopeForRel`) — every other path is confined to the
    // checkout root alone, exactly as before.
    const firstSegment = rel.split('/')[0];
    const admissibleRoots =
      firstSegment === '.planning'
        ? [roots.realRoot, bestPlanningScopeForRel(rel, roots.planningScopes)?.real ?? null].filter(
            (r): r is string => r !== null,
          )
        : [roots.realRoot];
    const resolved = path.resolve(projectRoot, rel);
    let bytes: Buffer;
    try {
      // A regular file INSIDE a known root can still be a symlink whose
      // TARGET escapes every known root — statSync/readFileSync follow
      // symlinks, so the lexical confinement check above is not enough.
      // realpathSync resolves the actual target; re-confining against the
      // admissible roots closes that gap.
      const real = fs.realpathSync(resolved);
      // Every operand is already realpath-resolved (this fn's own
      // realpathSync calls above), so the shared containment comparison
      // applies directly (ADR-4650) — no re-resolution through
      // assertWithinRoot/tryWithinRoot, which would redo work this function
      // already owns for its exists-vs-escaped tri-state.
      if (!admissibleRoots.some((root) => isContainedIn(real, root))) {
        return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };
      }
      const st = fs.statSync(real);
      if (!st.isFile()) return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };
      // #4623 (v2+): a repo-wide planning document is VALIDATED exactly as
      // every other covered path — confined, present, a regular file; the
      // fail-closed contract above is unchanged — but its bytes contribute
      // nothing to the digest. It may stay declared in `covered_files` (the
      // verifier's instructions long said to list the mapped requirement,
      // and every report already written does); its bookkeeping churn can
      // no longer read as drift.
      if (isSharedPlanningDoc(rel, sharedRoots)) continue;
      bytes = fs.readFileSync(real);
    } catch {
      return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };
    }
    const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
    parts.push(`${rel}\n${fileHash}\n`);
    hashed++;
  }
  // #4623 (v2+): a declaration made ONLY of shared planning documents has no
  // evidence in it at all — a constant digest over the header would satisfy
  // the fingerprint pair while grounding the verification in nothing. Fail
  // closed, the same way an empty declaration does.
  if (version >= 2 && hashed === 0) {
    return { ok: true, digest: null, files: declared, mappedPhaseDir: artifactMappedPhaseDir };
  }

  const aggregate = crypto
    .createHash('sha256')
    .update(`v${version}\n${parts.join('')}`, 'utf-8')
    .digest('hex');
  return { ok: true, digest: `v${version}:sha256:${aggregate}`, files: declared, mappedPhaseDir: artifactMappedPhaseDir };
}

/**
 * #4155/#5095: recompute the deterministic content fingerprint over a
 * verifier's declared covered-input set, returning JUST the digest string
 * (or `null` if unresolvable) — the signature every existing caller
 * (`readVerificationStatus`, tests) already depends on. Thin wrapper over
 * `deriveCoveredDigest`, collapsing its `{ ok: false, reason }` arm to `null`
 * exactly as the pre-#5095 single-function shape did.
 */
function computeCoveredDigest(
  projectRoot: string,
  coveredFiles: readonly string[],
  version: number = FINGERPRINT_VERSION,
  opts: { phaseDir?: string | null } = {},
): string | null {
  const result = deriveCoveredDigest(projectRoot, coveredFiles, version, opts);
  return result.ok ? result.digest : null;
}

/**
 * #4155: the content fingerprint only recomputes digests for paths the
 * verifier actually DECLARED in `covered_files` — it has no way to notice a
 * plan or summary added to the phase directory AFTER verification if that
 * new file was never declared. This closes that gap the same way the
 * legacy mtime check always did: by re-scanning the LIVE directory (not the
 * declared list) for every current `*-PLAN.md`/`*-SUMMARY.md` and checking
 * each is represented in `coveredFiles` — matched by suffix (mirrors
 * `matchRequestedFile`'s convention) since `coveredFiles` holds
 * project-root-relative paths while the scan returns phase-relative
 * filenames. Returns `true` if every current plan/summary is covered,
 * `false` otherwise — callers only ever branch on this pass/fail, so no
 * caller needs which artifact was uncovered.
 *
 * Fails CLOSED on an incomplete scan: `scanPhasePlans` never throws on a
 * readdir failure — it reports it via `scope` (`SCOPE.UNREADABLE` for the
 * phase dir itself, `SCOPE.TRUNCATED` for an unreadable nested `plans/`)
 * with whatever files it DID manage to enumerate, per `SCOPE`'s own
 * contract (`planning-scope.cts`): zero items under a non-`COMPLETE` scope
 * is a NON-answer, never "this phase has no plans." Branching on `scope`
 * here (rather than a try/catch, which this scan never triggers) is what
 * makes an unreadable `plans/` dir report `false` instead of silently
 * treating its invisible contents as vacuously covered — the same
 * fail-open regression #3057 B3 fixed for the legacy path.
 */
function allCurrentArtifactsCovered(phaseDir: string, coveredFiles: readonly string[]): boolean {
  const scan = scanPhasePlans(phaseDir);
  if (scan.scope !== SCOPE.COMPLETE) return false;
  const coveredPosix = canonicalizeCoveredFiles(coveredFiles);
  return [...scan.allPlanFiles, ...scan.summaryFiles].every((artifact) => {
    const artifactPosix = toPosix(artifact);
    return coveredPosix.some((c) => c === artifactPosix || c.endsWith(`/${artifactPosix}`));
  });
}

/**
 * Match a git-emitted (repo-root-relative) path back to the caller's
 * phaseDir-relative request by exact match or `/`-bounded suffix — precise
 * enough that a root file and a nested `plans/` file can never collide (a plain
 * basename match could). Returns the original caller-form file string, or null.
 */
function matchRequestedFile(gitPath: string, requested: string[], requestedPosix: string[]): string | null {
  const g = toPosix(gitPath);
  for (let i = 0; i < requested.length; i++) {
    const want = requestedPosix[i];
    if (g === want || g.endsWith('/' + want)) return requested[i];
  }
  return null;
}

/**
 * Parse `git log --format=%ct --name-only` output into file → most-recent commit
 * time (ms). Output is reverse-chronological, so a file's FIRST appearance
 * top-down is its latest commit. `%ct` headers are pure digits; path lines
 * contain a `.` (the `.md` extension) — so the two are unambiguous.
 */
function parseCommitTimes(
  stdout: string,
  requested: string[],
  requestedPosix: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  let currentCt: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (/^\d+$/.test(line)) {
      currentCt = Number.parseInt(line, 10);
      continue;
    }
    if (currentCt === null) continue;
    const rel = matchRequestedFile(line, requested, requestedPosix);
    if (rel !== null && !out.has(rel)) out.set(rel, currentCt * 1000);
  }
  return out;
}

/**
 * Default resolver: two bounded git calls per phase (never one-per-file — #2348 /
 * "Unbounded Subprocesses"; readVerificationStatus runs per-phase in the
 * init/roadmap listing loops, so per-file spawning would fan out to P×(S+1)):
 *
 *   1. `git log --first-parent --format=%ct --name-only -- <files…>` for commit
 *      times. `--first-parent` makes merge commits report their (first-parent)
 *      file lists — plain `--name-only` omits merge diffs, which would silently
 *      under-date content that landed via a conflict-resolving merge.
 *   2. `git diff --name-only HEAD -- <files…>` to drop any file whose working
 *      tree has diverged from HEAD: a committed-then-edited file must be timed by
 *      its mtime (the edit), never by its now-stale commit time.
 *
 * Paths pass after `--` so a dash-prefixed filename cannot be read as a flag. Any
 * non-answer (no repo, no commits, missing git) yields an empty map → the caller
 * times every file by mtime. Never throws. The per-phase file list is small (a
 * verification report + a handful of summaries), so the argv stays far below the
 * Windows 32K limit. `execGitFn` is injectable so the two-call error handling is
 * unit-testable without spawning git.
 */
type ExecGitFn = typeof execGit;

function defaultPhaseCleanCommitTimesMs(
  phaseDir: string,
  files: string[],
  execGitFn: ExecGitFn = execGit,
): Map<string, number> {
  if (files.length === 0) return new Map();
  const requestedPosix = files.map(toPosix);

  const logRes = execGitFn(['log', '--first-parent', '--format=%ct', '--name-only', '--', ...files], {
    cwd: phaseDir,
  });
  if (logRes.error || logRes.exitCode !== 0 || logRes.stdout.length === 0) return new Map();
  const commitTimes = parseCommitTimes(logRes.stdout, files, requestedPosix);
  if (commitTimes.size === 0) return commitTimes;

  // Drop dirty files (working tree ≠ HEAD) so their mtime is used instead. If the
  // dirty-check itself is INCONCLUSIVE (git diff errored / non-zero — as opposed
  // to "ran and reported no dirty files"), we cannot prove any file is clean, so
  // fail SAFE: discard the commit times and let every file fall back to mtime,
  // the same direction as a git-log failure. Trusting possibly-stale commit times
  // here would silently mask a real edit (false "not stale"). (#2348)
  const diffRes = execGitFn(['diff', '--name-only', 'HEAD', '--', ...files], { cwd: phaseDir });
  if (diffRes.error || diffRes.exitCode !== 0) return new Map();
  for (const line of diffRes.stdout.split('\n')) {
    if (line.length === 0) continue;
    const rel = matchRequestedFile(line, files, requestedPosix);
    if (rel !== null) commitTimes.delete(rel);
  }
  return commitTimes;
}

interface RouteResultContext {
  runtime: string;
  /** ` <N>` (leading space) or `''` — see readVerificationStatus's derivation. */
  phaseArg: string;
  staleCheckIndeterminate?: boolean;
  /** A usage-error message (`phase_dir_not_found` names the path it looked at). */
  message?: string;
}

/**
 * The one result builder (#5118): every `VerificationStatusResult` is
 * projected from `VERIFICATION_ROUTES[status]` here — `route` (the bare
 * command) and `next_command` (its runtime projection, #2617) come from the
 * same table entry, so they cannot disagree.
 */
function routeResult(status: VerificationStatus, ctx: RouteResultContext): VerificationStatusResult {
  const entry = VERIFICATION_ROUTES[status];
  return {
    status,
    next_action: entry.next_action,
    next_command: projectNextCommand(entry.command, ctx.runtime, `${ctx.phaseArg}${entry.tail}`),
    route: entry.command,
    ...(ctx.message !== undefined ? { message: ctx.message } : {}),
    ...(ctx.staleCheckIndeterminate ? { staleCheckIndeterminate: true } : {}),
  };
}

/**
 * ADR-5057 amendment 2 (#4987): true only when there is no phase DIRECTORY at
 * `phaseDir` — `stat` fails with ENOENT / ENOTDIR (a dangling symlink stats as
 * ENOENT), or it succeeds on something that is not a directory (a regular
 * file). Any other stat failure — EACCES, or a code-less containment error
 * from an injected FsLike (planning-inspect's seam) — is NOT "not found": the
 * caller falls through to the existing readdir path (`missing`).
 */
function isPhaseDirNotFound(fsImpl: FsLike, phaseDir: string): boolean {
  let st: ReturnType<FsLike['statSync']>;
  try {
    st = fsImpl.statSync(phaseDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
  return typeof st?.isDirectory === 'function' && !st.isDirectory();
}

function phaseDirNotFoundMessage(phaseDir: string): string {
  return `Usage error: phase directory not found at ${io.formatDiagnosticToken(phaseDir)}`;
}

/**
 * The PHASES ROOT a phase directory must live under: the parent of `phaseDir`
 * in its own (unresolved) spelling. It is the fixed anchor of the containment
 * check — a phase directory symlinked outside the project resolves outside, so
 * containing a report against that directory's OWN realpath alone would admit
 * the escape (both resolve outside). A phases root that is itself a symlinked
 * per-scope store resolves consistently on both sides of the comparison.
 */
function planningContainmentRoot(phaseDir: string): string {
  return path.dirname(path.resolve(phaseDir));
}

/**
 * True when the phase directory really lives under its phases root AND
 * `filePath` really lives inside that phase directory (symlinks followed on
 * both). Either escape reads `missing`. Unresolvable → false.
 */
function isReportContained(phaseDir: string, filePath: string): boolean {
  try {
    const realDir = fs.realpathSync(phaseDir);
    return isContainedIn(realDir, fs.realpathSync(planningContainmentRoot(phaseDir)))
      && isContainedIn(fs.realpathSync(filePath), realDir);
  } catch {
    return false;
  }
}

/** What the frontmatter-only locator found for a phase directory. */
type LocatedReport =
  | { kind: 'phase_dir_not_found' }
  | { kind: 'missing' }
  | { kind: 'unparseable' }
  | { kind: 'status'; status: VerifierStatus; filePath: string; fm: Record<string, unknown> };

/**
 * #5118: steps 0-2 of `readVerificationStatus` — no phase directory
 * (`phase_dir_not_found`), no report or no `status` (`missing`), a report
 * whose frontmatter is not YAML (`unparseable`), or the report's writer-set
 * status. Reads only the report's frontmatter (no staleness check, no git).
 * THROWS `VerificationStatusError` for a status outside the writer set — the
 * one judgement (`reportStatusOf`) every reader shares.
 */
function locatePhaseReport(phaseDir: string, fsImpl: FsLike, convention?: string | null): LocatedReport {
  if (isPhaseDirNotFound(fsImpl, phaseDir)) return { kind: 'phase_dir_not_found' };

  const baseName = path.basename(phaseDir);
  let verificationFile: string | null = null;
  try {
    const entries = fsImpl.readdirSync(phaseDir);
    // #3492: pin selection to THIS phase's own token so a stray cross-phase
    // or sentinel-numbered canonically-shaped file cannot outrank this phase's
    // own report. #612: bracket directories resolve with the convention-aware
    // token. #4187: keep the bare report tier aligned with every other reader.
    const resolutionToken = convention === 'bracket'
      ? extractPhaseToken(baseName, convention)
      : extractPhaseToken(baseName);
    verificationFile = resolveVerificationFile(entries, {
      allowBare: true,
      phaseToken: resolutionToken,
      phaseDirName: baseName,
      convention,
    });
  } catch {
    // Directory unreadable → treat as missing
    verificationFile = null;
  }
  if (!verificationFile) return { kind: 'missing' };

  // extractFrontmatter anchors at byte 0, so body `status:` lines are ignored.
  const filePath = path.join(phaseDir, verificationFile);
  // #5118 security review (containment): a report whose real path escapes its
  // own phase directory (a symlink out of the project) is refused BEFORE a
  // byte of it is read — it reads `missing`, and no value from it can ever
  // reach a message (the out-of-set error echoes the report's `status`). An
  // injected FsLike (planning-inspect's containment seam) enforces its own
  // containment by throwing, which the read below folds to `missing` too.
  if (fsImpl === defaultFsImpl && !isReportContained(phaseDir, filePath)) return { kind: 'missing' };
  let fm: Record<string, unknown> = {};
  try {
    // #3707-CR: normalize line endings at this read boundary so a lone-CR
    // report's `---\r…\r---` fence still matches extractFrontmatter's check.
    const content = normalizeLineEndings(fsImpl.readFileSync(filePath, 'utf-8'));
    fm = extractFrontmatter(content, filePath);
    // #4806: an unparseable frontmatter block is NOT "missing" — the file
    // exists and verification ran; the caller is sent to fix the YAML.
    if ((fm as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true) {
      return { kind: 'unparseable' };
    }
  } catch {
    // An unreadable report reads as carrying no status (`missing`).
    fm = {};
  }

  // #5118: judged OUTSIDE the parse `try`, so an out-of-set value can never be
  // swallowed into `missing`.
  const status = reportStatusOf(fm, filePath);
  if (status === null) return { kind: 'missing' };
  return { kind: 'status', status, filePath, fm };
}

/**
 * #5118 (ADR-5057 Phase 4, "no write before the error"): the first report
 * among `phaseDirs` whose `status` is outside the closed set, or `null`.
 * Frontmatter-only (the same locator `readVerificationStatus` runs), so a
 * command that WRITES validates every report it will read BEFORE its first
 * write and fails having written nothing.
 */
function findVerificationStatusError(
  phaseDirs: readonly string[],
  deps: { fs?: FsLike; convention?: string | null } = {},
): VerificationStatusError | null {
  const fsImpl: FsLike = deps.fs ?? defaultFsImpl;
  for (const phaseDir of phaseDirs) {
    try {
      locatePhaseReport(phaseDir, fsImpl, deps.convention);
    } catch (err) {
      if (err instanceof VerificationStatusError) return err;
      throw err;
    }
  }
  return null;
}

interface ResolveVerificationFileOptions {
  /**
   * #3473 F2: three OTHER hand-rolled selection sites (`src/commands.cts`'s
   * phase-status ladder — since folded into the Phase Status Module, #5060 —
   * and two `verification_path` projectors in `src/init.cts`) additionally
   * accept a BARE `VERIFICATION.md` — a form
   * this module's own two callers (`findStaleVerificationSummary`,
   * `readVerificationStatus`) had never accepted, because a bare filename
   * carries no phase token and `.endsWith('-VERIFICATION.md')` structurally
   * excludes it. Defaults to `false`, which is byte-for-behavior identical to
   * the pre-existing (non-optioned) resolver — no call-site edit required for
   * callers that do not want the bare tier.
   *
   * #4187: that historical asymmetry was drift, not contract. Six call sites
   * grew around the shared resolver and four opted in
   * (`cmdVerificationResolveFile`, `src/commands.cts`'s phase-status ladder —
   * since folded into the Phase Status Module, #5060 — and both init
   * `verification_path` projectors) — the two module-internal status-path
   * call sites (`readVerificationStatus`, `findStaleVerificationSummary`)
   * did not, so `query verification.resolve-file` resolved a bare report in
   * a directory where `query verification.status` answered `missing` and
   * recommended re-running execute-phase for an already-verified phase.
   * Since #4187 those two pass `true` as well: every reader of the report
   * set now recognizes the bare name. Tier order is unchanged — a dashed
   * candidate (canonical or not, if it belongs to THIS phase) still outranks
   * the bare match — so this only changes directories whose SOLE report is
   * bare.
   */
  allowBare?: boolean;
  /**
   * #3492 regression fix: the phase token (`extractPhaseToken` on the phase
   * directory's own basename — same grammar `src/phase-id.cts` owns via
   * `PHASE_NUMBER_TOKEN_SOURCE`) THIS call is resolving for. Every call site
   * knows its own phaseDir, so every call site can derive and pass this.
   *
   * Pinning selection to the caller's own phase is load-bearing: preferring
   * ANY canonically-shaped `<token>-VERIFICATION.md` (regardless of whose
   * token it carries) let a stray cross-phase or sentinel-numbered file
   * (`999-VERIFICATION.md`) outrank the phase's own non-canonical report
   * (`12-review-VERIFICATION.md`) — a regression this option closes.
   *
   * Omitted / empty when the token cannot be derived: falls back to plain
   * alphabetically-first among the SCOPED dashed candidates (see
   * `phaseDirName` below), never to null.
   */
  phaseToken?: string;
  /**
   * #3511 reconciliation: the phase directory's own basename (the same value
   * every call site already passes through `extractPhaseToken` to derive
   * `phaseToken` above) — needed separately because the fallback below scopes
   * by `isPhaseArtifact(fileName, phaseDirName)`, not by `phaseToken`.
   *
   * Omitted: the fallback degrades to the plain (unscoped) alphabetically-first
   * pick — the original pre-#3357 behavior — never to null.
   */
  phaseDirName?: string;
  /**
   * #612: the repo's resolved `phase_id_convention`, threaded verbatim into
   * `scopeToPhase(candidates, phaseDirName, convention)` so the fallback
   * scopes a bracket dir (`{CODE}.{MM}-{PP}-slug`) by its real phase token
   * instead of the include-everything ambiguity fail-safe. Same ADR-2121
   * additive shape as every other convention thread: omitted / null resolves
   * to the unchanged legacy scoping.
   */
  convention?: string | null;
}

/**
 * #3518: `resolveUatFile`'s options — same two knobs, same semantics, as
 * `ResolveVerificationFileOptions` above (the UAT artifact is selected by the
 * identical phase-pinned rule the verification report is; see
 * `resolvePhaseArtifactFile` below for the single shared selection core).
 */
type ResolveUatFileOptions = ResolveVerificationFileOptions;

/**
 * #3518: the shared phase-pinned artifact-selection core BOTH single-pick
 * resolvers (`resolveVerificationFile` for `*-VERIFICATION.md`,
 * `resolveUatFile` for `*-UAT.md`) delegate to — one rule, not two grammars
 * that agree today and drift tomorrow (epic #3473 F2's defect class).
 *
 * `bareName` is the artifact filename WITHOUT the leading dash (`'UAT.md'`);
 * a "dashed" candidate is any entry ending `-${bareName}`.
 *
 * Selection order:
 *   1. `options.phaseToken` given and `<phaseToken>-${bareName}` is among
 *      the candidates — that exact file always wins: it is THIS phase's own
 *      artifact, and no other candidate (whichever phase's token it carries)
 *      can outrank it (#3492 / #3518).
 *   2. Fallback — no exact phase-token match (or no token given): alphabetically
 *      first of the dashed candidates that are THIS phase's own, per
 *      `scopeToPhase(candidates, options.phaseDirName)` (#3511 reconciliation,
 *      below). Load-bearing: a phase whose only artifact is non-canonically
 *      named must keep resolving to it, not to null — this fix must not turn
 *      "found an artifact" into "found nothing" for anyone. A
 *      non-canonically-named artifact of THIS phase (e.g.
 *      `03-CORRECTION-VERIFICATION.md` in `03-foo`) still passes
 *      `isPhaseArtifact` (it names phase 03, same as the directory), so it
 *      is still returned here.
 *   3. `options.allowBare` only — a bare `${bareName}`, ranked BELOW both
 *      of the above. Rationale: a dashed file names its phase, a bare one
 *      does not, so a dashed file (canonical or not) is always the better
 *      answer when both exist. Reached when neither (1) nor (2) found any
 *      candidate — including when (2)'s scoping filtered every dashed
 *      candidate out as belonging to some OTHER phase.
 *
 * #3511 RECONCILIATION with `isPhaseArtifact` (`src/phase-id.cts`): that
 * predicate's own docblock used to flag this fallback as an open gap — its
 * aggregate scans exclude a cross-phase stray, but this single-pick resolver
 * did not, so it could return a stray as THE artifact while the aggregate
 * scans correctly ignored it. Closed by scoping step (2) above through
 * `scopeToPhase` (`src/phase-id.cts`, itself built on `isPhaseArtifact`):
 * `options.phaseDirName` threads the phase directory's basename in, and the
 * fallback now filters candidates through `scopeToPhase(candidates,
 * phaseDirName)` before picking alphabetically-first. This does NOT reopen
 * the #3357 guarantee — that guarantee is "a phase whose only report is
 * non-canonically named must keep working", and a non-canonically-named
 * artifact of THIS phase still passes `isPhaseArtifact` (it is membership by
 * phase number, not by canonical shape), so it is still returned. Only a
 * file belonging to a DIFFERENT phase is now excluded — and excluding it is
 * correct: returning another phase's artifact as this phase's own is worse
 * than reporting none (confidently wrong beats honestly empty).
 * The fail-safe now lives entirely inside `isPhaseArtifact`, not in
 * `scopeToPhase` (which is a plain filter with no unfiltered fallback):
 * (a) when phase-number membership cannot be determined for `phaseDirName` at
 * all (no reliable token — the zero-token directory case), every candidate is
 * treated as belonging to the phase; (b) the `firstLetterPrefixed`
 * bracket-ambiguity case, where a letter-prefixed-decimal dir is
 * string-indistinguishable from a bracket-dir token, also includes
 * everything rather than guess; (c) a token-less filename (bare
 * `${bareName}`) is accepted by directory containment alone. Outside
 * those cases, when scoping DOES remove every dashed candidate — a real
 * cross-phase stray, or a phase whose own artifact is genuinely absent — the
 * fallback below correctly falls through to `allowBare`/`null`: reporting no
 * artifact, not another phase's. `options.phaseDirName` omitted entirely skips
 * the filter outright (the ternary below), which is unscoped, pre-#3511
 * behavior.
 *
 * Pure — takes an already-read directory listing and does no I/O of its own,
 * so every call site keeps its existing `fsImpl` seam and no-throw contract
 * untouched.
 */
function resolvePhaseArtifactFile(
  entries: string[],
  bareName: string,
  options: ResolveVerificationFileOptions = {},
): string | null {
  const candidates = entries.filter((f) => f.endsWith(`-${bareName}`)).sort();
  if (candidates.length > 0) {
    if (options.phaseToken) {
      const thisPhaseFile = `${options.phaseToken}-${bareName}`;
      if (candidates.includes(thisPhaseFile)) return thisPhaseFile;
    }
    // #3511: scope the fallback to files that belong to THIS phase, so a
    // stray cross-phase file can no longer outrank a return of null.
    // `phaseDirName` omitted, or membership undeterminable for it, →
    // unscoped `candidates` (pre-#3511 behavior); otherwise strays are
    // filtered out, and if that leaves nothing the code falls through to
    // `allowBare`/`null` deliberately.
    const scoped = options.phaseDirName
      ? scopeToPhase(candidates, options.phaseDirName, options.convention)
      : candidates;
    if (scoped.length > 0) return scoped[0];
  }
  if (options.allowBare && entries.includes(bareName)) return bareName;
  return null;
}

/**
 * Resolve which `*-VERIFICATION.md` entry in a phase directory's listing IS
 * the phase's verification report, when more than one such file exists.
 *
 * #3357: a phase dir can legitimately hold more than one `*-VERIFICATION.md`
 * — the real per-phase report (`03-VERIFICATION.md`) alongside an ad-hoc plan
 * worksheet (`03-CORRECTION-VERIFICATION.md`). Picking "alphabetically first"
 * (`'C' < 'V'`) silently chose the worksheet, which usually has no
 * frontmatter `status:`, so a phase with a PASSING report read as `missing`.
 * This was two independent hand-rolled `.sort()[0]` picks
 * (findStaleVerificationSummary and readVerificationStatus) — this is the
 * single resolver both now call (#3473 F2).
 *
 * Selection order: see `resolvePhaseArtifactFile` (the shared core this
 * delegates to since #3518, itself phase-scoped since #3511) —
 * phase-token-pinned, then phase-scoped alphabetically-first dashed
 * fallback, then (allowBare only) a bare `VERIFICATION.md`. #3518 extracted
 * this into the shared core without changing behavior; #3511's
 * `phaseDirName` scoping now lives inside that shared core rather than here.
 */
function resolveVerificationFile(
  entries: string[],
  options: ResolveVerificationFileOptions = {},
): string | null {
  return resolvePhaseArtifactFile(entries, 'VERIFICATION.md', options);
}

/**
 * #3518: resolve which `*-UAT.md` entry in a phase directory's listing IS
 * the phase's UAT artifact, when more than one such file exists — the UAT
 * counterpart of `resolveVerificationFile`, sharing its exact selection rule
 * via `resolvePhaseArtifactFile`.
 *
 * The bug this closes: both `uat_path` projectors in `src/init.cts` picked
 * with a bare `.find((f) => f.endsWith('-UAT.md') || f === 'UAT.md')` over an
 * unsorted `readdir` listing — no phase-membership check and no ordering — so
 * a stray or cross-phase `04-UAT.md` sitting in phase 03's directory could
 * become phase 03's `uat_path`, and WHICH file won was filesystem-dependent
 * (creation order on APFS, hash order on ext4/XFS): two machines on the same
 * commit could emit different `uat_path` values for the same phase. `uat_path`
 * is consumed downstream by workflows that then read the named file, so a
 * wrong path routes UAT state from another phase.
 *
 * Deterministic by construction: same answer on every machine. Phase-scoped
 * (#3511): passing `options.phaseDirName` filters the alphabetically-first
 * fallback (tier 2) to artifacts that belong to THIS phase — see
 * `resolvePhaseArtifactFile` for the full selection order and scoping
 * rationale.
 */
function resolveUatFile(
  entries: string[],
  options: ResolveUatFileOptions = {},
): string | null {
  return resolvePhaseArtifactFile(entries, 'UAT.md', options);
}

// ─── Public API ───────────────────────────────────────────────────────────────

interface ReadVerificationStatusOptions {
  fs?: FsLike;
  /** Injectable per-phase clean-commit-time resolver for the staleness clock (#2348). */
  phaseCleanCommitTimesMs?: PhaseCleanCommitTimesFn;
  /**
   * Runtime whose command surface `next_command` is projected into (#2617).
   * Callers that have a cwd should pass `resolveRuntime(cwd)`. Defaults to
   * `'claude'`, which yields the canonical `/gsd-<cmd>` hyphen form — never the
   * deprecated `/gsd:` colon form this field used to hard-code.
   */
  runtime?: string;
  /**
   * Phase number appended to the routed command (#2617). Defaults to the token
   * parsed from `phaseDir`, but only when that token is unambiguously numeric.
   * Callers that already know the number pass it explicitly — `init` reaches
   * this with `phaseDir` unresolved in some branches.
   */
  phaseNumber?: string;
  /**
   * #612: the repo's resolved `phase_id_convention`, threaded through to
   * `resolveVerificationFile` (exact-pin token + fallback scoping) and
   * `findStaleVerificationSummary` so a bracket phase dir resolves and
   * scopes its report exactly like its legacy twin. Deliberately NOT used
   * for the routed command argument — see the derivation comment in the
   * body. Omitted / null: unchanged legacy behavior.
   */
  convention?: string | null;
}

interface VerificationStatusResult {
  status: VerificationStatus;
  next_action: string;
  /** The runtime-projected, human-facing command (#2617) — `''` when there is none. */
  next_command: string;
  /**
   * #5118: the BARE command the owner routes this status to (`''`,
   * `execute-phase`, `plan-phase`, `verify-work`), from the same
   * VERIFICATION_ROUTES entry as `next_command`. A workflow branches on this —
   * never on a runtime-specific `/gsd-…` string, never on the status word.
   */
  route: RouteCommand;
  /** #5118: the usage-error message on `phase_dir_not_found` (names the path it looked at). */
  message?: string;
  /**
   * True when the internal staleness check (findStaleVerificationSummary)
   * could not run to completion (an fs / scanPhasePlans / clock failure) —
   * `status` above was routed as if the phase were not stale (the pre-existing
   * no-throw fail-open contract, preserved unchanged), but this flag lets a
   * caller distinguish "checked; nothing is stale" from "could not check" so
   * the two are no longer silently identical (#3057 B3). Omitted (not present)
   * when the staleness check ran to completion, or was never reached (e.g. the
   * `gaps_found` short-circuit above it, or no verification file at all).
   */
  staleCheckIndeterminate?: boolean;
}

function findStaleVerificationSummary(
  phaseDir: string,
  fsImpl: FsLike = defaultFsImpl,
  phaseCleanCommitTimesMs: PhaseCleanCommitTimesFn = defaultPhaseCleanCommitTimesMs,
  convention?: string | null,
): StaleCheckResult {
  // FS errors (TOCTOU: a SUMMARY listed by scanPhasePlans then removed before statSync;
  // unreadable dir; broken symlink; file->dir swap) must degrade rather than throw
  // uncaught into callers that are NOT under the planning lock (init.manager /
  // init.progress / uat-predicate). Mirrors readVerificationStatus's no-throw
  // contract; `fsImpl` threads the same injectable-fs seam for parity/testing.
  // (Review B1 on #1548.) The degraded result is `{determined:false}`, NOT the
  // same value as a completed "nothing is stale" check — see StaleCheckResult
  // doc and #3057 B3. The caller decides how to route an indeterminate result;
  // this function only reports what it actually knows.
  try {
    const phaseFiles = fsImpl.readdirSync(phaseDir);
    // #3492: pin selection to THIS phase's own token so a stray cross-phase
    // or sentinel-numbered canonically-shaped file cannot outrank this
    // phase's own (possibly non-canonical) report. #3511: phaseDirName scopes
    // the fallback path to this same phase (see resolveVerificationFile docs).
    // #4187: allowBare — this staleness seam must see the same report set the
    // status reader sees, or a bare report could never read `stale` while its
    // dashed twin could (two answers from one verb).
    const phaseDirName = path.basename(phaseDir);
    // #612: derive the token with the resolved convention so a bracket dir's
    // own token is read behind its `{CODE}.{MM}-` prefix. #4187: keep the bare
    // report tier aligned with the status reader.
    const phaseToken = extractPhaseToken(phaseDirName, convention);
    const verificationFile = resolveVerificationFile(phaseFiles, {
      allowBare: true,
      phaseToken,
      phaseDirName,
      convention,
    });
    if (!verificationFile) return { determined: true, stale: false };

    const summaryFiles = (scanPhasePlans(phaseDir) as { summaryFiles: string[] }).summaryFiles
      .slice()
      .sort();
    // No summary can be newer than the verification → never stale. Return before
    // touching git so a phase with no summaries costs zero subprocesses. (#2348)
    if (summaryFiles.length === 0) return { determined: true, stale: false };

    // Each file's effective "last changed" time = its commit time when committed
    // AND clean (content-tied and clone-stable), else its filesystem mtime (the
    // uncommitted working-tree edit). Both are real wall-clock change times, so
    // comparing a clean file's commit time against a dirty file's mtime is sound.
    // One resolver call = two git subprocesses for the whole phase. (#2348)
    const cleanCommitMs = phaseCleanCommitTimesMs(phaseDir, [verificationFile, ...summaryFiles]);
    const effectiveTimeMs = (file: string): number =>
      cleanCommitMs.has(file)
        ? (cleanCommitMs.get(file) as number)
        : fsImpl.statSync(path.join(phaseDir, file)).mtimeMs;

    const verificationTimeMs = effectiveTimeMs(verificationFile);
    for (const summaryFile of summaryFiles) {
      // The caller only needs whether the phase is stale, not which summary —
      // the first stale summary (in sorted order) is enough. Short-circuit.
      if (effectiveTimeMs(summaryFile) > verificationTimeMs) {
        return { determined: true, stale: true, verificationFile, summaryFile };
      }
    }

    return { determined: true, stale: false };
  } catch {
    return { determined: false };
  }
}

/**
 * Read the verification status from the first `*-VERIFICATION.md` file in
 * phaseDir and return the routing result.
 *
 * Behavior:
 * 1. Find the phase's verification report via `resolveVerificationFile`
 *    (canonical `<phase-token>-VERIFICATION.md` preferred; falls back to the
 *    alphabetically-first `*-VERIFICATION.md` that belongs to THIS phase when
 *    none is canonical — #3357/#3511; and, when the directory's only report
 *    is a bare `VERIFICATION.md`, that file — #4187, matching
 *    `verification.resolve-file`). If none → status 'missing'.
 * 2. Extract `status` from FRONTMATTER ONLY via the shared extractFrontmatter
 *    parser (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix — parser anchors at byte 0).
 *    If no frontmatter block or no `status` key → status 'missing'.
 * 3. Route through VERIFICATION_ROUTES (`routeResult`). A status outside the
 *    writer set (`VERIFIER_STATUSES`) — any other string, case variant,
 *    reader-only member, or non-string value — THROWS `VerificationStatusError`
 *    (#5118). The throw sits outside the parse `try`, and before the
 *    `gaps_found` short-circuit and the staleness check, so it can neither be
 *    folded into `missing` nor masked by `stale` (#4817 Part 2).
 *
 * #5118 / ADR-5057 amendment 2: a path with no phase DIRECTORY behind it
 * (ENOENT, ENOTDIR, a non-directory) reads `phase_dir_not_found` — a usage
 * error with no next command — not `missing` (#4987).
 *
 * The internal staleness check can itself fail (fs / scanPhasePlans / clock
 * error); when it does, `status` is routed as if nothing were stale (the
 * pre-existing no-throw fail-open contract — unchanged), but the returned
 * result carries `staleCheckIndeterminate: true` so a caller can distinguish
 * "checked; nothing is stale" from "could not check" (#3057 B3).
 *
 * @param phaseDir - Absolute path to the phase directory.
 * @param opts     - Options. `opts.fs` allows test injection (defaults to node:fs).
 *                   `opts.runtime` selects the command surface `next_command` is
 *                   projected into (#2617).
 */
function readVerificationStatus(
  phaseDir: string,
  opts: ReadVerificationStatusOptions = {},
): VerificationStatusResult {
  const fsImpl: FsLike = opts.fs ?? defaultFsImpl;
  const phaseCleanCommitTimesMs: PhaseCleanCommitTimesFn =
    opts.phaseCleanCommitTimesMs ?? defaultPhaseCleanCommitTimesMs;
  const runtime = opts.runtime ?? 'claude';

  // Phase token for the gaps_found command — deliberately convention-LESS
  // even when `opts.convention` is present: the token becomes a bare COMMAND
  // ARGUMENT below, and a bare bracket phase number is milestone-ambiguous
  // (`02` cannot tell GSD.01-02 from GSD.02-02), so the argument keeps its
  // pre-#612 shape. The convention-aware token is derived separately for
  // FILE RESOLUTION only (`resolutionToken`, at the readdir below).
  const baseName = path.basename(phaseDir);
  const phaseToken = extractPhaseToken(baseName);
  const derivedPhaseNumber = phaseToken.length > 0 ? phaseToken : baseName;
  // #2617: the phase number becomes a COMMAND ARGUMENT, so it is appended only
  // when it is unambiguously one. extractPhaseToken also returns project-code
  // forms (`PROJ-07`), which are indistinguishable by shape from an ordinary
  // directory name — `gsd-651-parent` yields `gsd-651` — and emitting
  // `execute-phase gsd-651` is worse than emitting no argument at all. Callers
  // that already know the number (init) pass it explicitly and always get it.
  const phaseArgSource = opts.phaseNumber ?? (/^\d+(\.\d+)*$/.test(derivedPhaseNumber) ? derivedPhaseNumber : '');
  const phaseArg = phaseArgSource ? ` ${phaseArgSource}` : '';
  const route = (status: VerificationStatus, extra: Partial<RouteResultContext> = {}): VerificationStatusResult =>
    routeResult(status, { runtime, phaseArg, ...extra });

  // Steps 0-2 (no phase dir → usage error; find the report; parse its
  // frontmatter and judge `status`) are the frontmatter-only locator shared
  // with the pre-write validator (`findVerificationStatusError`). An
  // out-of-set status THROWS VerificationStatusError out of the locator —
  // before the gaps_found short-circuit and the staleness check below, so
  // `stale` can never mask it (#4817 Part 2).
  const located = locatePhaseReport(phaseDir, fsImpl, opts.convention);
  if (located.kind === 'phase_dir_not_found') {
    return route(VERIFICATION_STATUS.PHASE_DIR_NOT_FOUND, { message: phaseDirNotFoundMessage(phaseDir) });
  }
  if (located.kind === 'missing') return route(VERIFICATION_STATUS.MISSING);
  if (located.kind === 'unparseable') return route(VERIFICATION_STATUS.UNPARSEABLE);
  const { status: reportStatus, fm } = located;

  // gaps_found takes priority over stale — gap closure is the correct next
  // step regardless of whether summaries are newer than the verification file.
  if (reportStatus === VERIFICATION_STATUS.GAPS_FOUND) {
    return route(VERIFICATION_STATUS.GAPS_FOUND);
  }

  // #4155: a report that declares a covered-input fingerprint is checked by
  // RECOMPUTING that fingerprint over current file content — strictly
  // content-grounded, and it REPLACES (not supplements) the legacy
  // SUMMARY-mtime check below for that report. A report with no fingerprint
  // metadata (every report written before #4155) keeps the exact legacy
  // mtime-based behavior, unchanged.
  const coveredFilesVal = fm['covered_files'];
  const coveredDigestVal = fm['covered_digest'];
  // A report OPTS IN to the fingerprint check by declaring EITHER field —
  // once opted in, an incomplete or malformed pair (one field present but
  // not the other, an empty array, a non-array, a blank digest) fails closed
  // to `stale` rather than silently downgrading to the weaker legacy
  // mtime-only check, which would only ever notice a newer SUMMARY.
  const declaresFingerprint = coveredFilesVal !== undefined || coveredDigestVal !== undefined;
  const hasWellFormedFingerprint =
    Array.isArray(coveredFilesVal) &&
    coveredFilesVal.length > 0 &&
    coveredFilesVal.every((f) => typeof f === 'string') &&
    typeof coveredDigestVal === 'string' &&
    coveredDigestVal.trim().length > 0;

  let staleCheckIndeterminate = false;
  let isStale: boolean;
  if (declaresFingerprint) {
    // Stated directly rather than relying on `null !== coveredDigestVal`
    // being true whenever the pair is malformed: `!hasWellFormedFingerprint`
    // fails closed explicitly, and its `||` short-circuit means
    // computeCoveredDigest/allCurrentArtifactsCovered never run on a
    // malformed (wrong-shaped) `coveredFilesVal`. The two `||`s after it
    // short-circuit in turn: the live-directory re-scan (for a plan/summary
    // added AFTER verification and never declared in covered_files) only
    // runs once the digest itself has already matched.
    //
    // #4623: recompute under the STORED digest's own version, not the
    // current constant — a v1/v2 report written before a later semantics
    // change keeps its own semantics rather than going stale on upgrade. An
    // unknown version parses to `null`, which `computeCoveredDigest`
    // refuses (returns `null`), so the compare below fails closed.
    const projectRoot = resolveProjectRoot(phaseDir);
    const storedVersion =
      hasWellFormedFingerprint && typeof coveredDigestVal === 'string'
        ? parseFingerprintVersion(coveredDigestVal)
        : null;
    if (!hasWellFormedFingerprint || storedVersion === null) {
      isStale = true;
    } else if (storedVersion >= 3) {
      // #5095 (R1): v3's digest is computed over the declared set UNIONED
      // with the phase's own live artifacts — a plan/summary added after
      // fingerprinting already moves the digest itself, so the separate
      // live-directory re-scan (`allCurrentArtifactsCovered`) is redundant
      // for v3 and is not run.
      isStale =
        computeCoveredDigest(projectRoot, coveredFilesVal, storedVersion, { phaseDir }) !== coveredDigestVal;
    } else {
      // v1/v2: unchanged — the digest alone cannot see a plan/summary that
      // was never declared, so the live-directory re-scan still runs.
      isStale =
        computeCoveredDigest(projectRoot, coveredFilesVal, storedVersion, { phaseDir }) !== coveredDigestVal ||
        !allCurrentArtifactsCovered(phaseDir, coveredFilesVal);
    }
  } else {
    const staleCheck = findStaleVerificationSummary(
      phaseDir,
      fsImpl,
      phaseCleanCommitTimesMs,
      opts.convention,
    );
    isStale = staleCheck.determined && staleCheck.stale;
    // staleCheck is either {determined:true, stale:false} (checked; nothing
    // stale) or {determined:false} (could not check — fs/scan/clock failure).
    // Both fall through to normal routing below (the pre-existing no-throw
    // fail-open contract is unchanged), but the indeterminate case is flagged
    // on the returned result so a caller can tell the two apart (#3057 B3).
    staleCheckIndeterminate = !staleCheck.determined;
  }
  if (isStale) {
    // #4682 / #5118: the one stale route — execute-phase's verify_phase_goal
    // step re-runs the verifier, regenerating VERIFICATION.md and its digest.
    return route(VERIFICATION_STATUS.STALE);
  }

  // 3. Route the writer-set member through the one table.
  return route(reportStatus, { staleCheckIndeterminate });
}

interface IsPhaseCompleteDeps {
  fs?: FsLike;
  /** Injectable per-phase clean-commit-time resolver, threaded through to readVerificationStatus. */
  phaseCleanCommitTimesMs?: PhaseCleanCommitTimesFn;
  /** Runtime whose command surface next_command is projected into (#2617). */
  runtime?: string;
  /** Phase number appended to the routed command (#2617). */
  phaseNumber?: string;
  /**
   * #612: the repo's resolved `phase_id_convention`, threaded through to
   * readVerificationStatus so a bracket phase dir resolves and scopes its
   * report exactly like its legacy twin. Omitted / null: unchanged.
   */
  convention?: string | null;
}

/**
 * #5118: `isPhaseComplete`'s projection of a report whose `status` is outside
 * the closed set — NOT a VerificationStatus (`unparseable` keeps its one
 * meaning: the frontmatter does not parse). `status: null`, no route, and the
 * error's own message as `next_action`.
 */
interface InvalidVerificationReading {
  status: null;
  next_action: string;
  next_command: '';
  route: '';
}

/** What `isPhaseComplete` read: a routed VerificationStatus, or the out-of-set projection. */
type PhaseVerificationReading = VerificationStatusResult | InvalidVerificationReading;

interface PhaseCompletionValue {
  complete: boolean;
  verification: PhaseVerificationReading;
  /**
   * #5118: set exactly when `verification.status` is `null` — the report's
   * `status` is outside the closed set. The owner keeps its no-throw contract
   * (scope UNREADABLE); every aggregate carries this error in its own result
   * and its CLI surface fails with the error's own `.reason`.
   */
  statusError?: VerificationStatusError;
}

/**
 * isPhaseComplete — the single canonical owner of "is phase P complete?"
 * (ADR-3180 §7.4, Decision 1). Sited beside readVerificationStatus, which it
 * wraps.
 *
 * DISK-STRICT (#2957, maintainer decision 2026-08-08; ADR-3180 §7.4 amended
 * af92fd4c9): readVerificationStatus is called UNCONDITIONALLY here — plan
 * count is NOT a precondition. A phase with zero plans and a passing
 * `*-VERIFICATION.md` is complete (#3168). A ROADMAP checkbox has no machine
 * authority and is never consulted — this function never reads ROADMAP.md.
 *
 * `complete` is exactly `verification.status === VERIFICATION_STATUS.PASSED`.
 * `verification` carries the FULL routing result
 * (status/next_action/next_command/route), so a caller can distinguish a
 * failing verdict (`gaps_found`/`human_needed`/`stale`) from an absent one
 * (`missing`) — both are "not complete", but they are not the same
 * non-answer.
 *
 * #5118: a report whose `status` is outside the closed set does NOT throw
 * out of here (ADR-5057 :223 — the no-throw contract Phases 2–4 preserve): it
 * degrades to scope UNREADABLE, `verification.status` is `null` (route `''`,
 * the error's message as `next_action`), `complete` is false, and
 * `value.statusError` holds the typed error for the caller to carry.
 *
 * `scope` is UNREADABLE when `phaseDir` itself could not be listed — this is
 * INDEPENDENT of readVerificationStatus's own no-throw fail-open contract for
 * a missing `*-VERIFICATION.md` file (a well-formed answer,
 * `verification.status === 'missing'`, scope COMPLETE): a caller must not
 * read `value.complete: false` here as a confident "not complete" the way it
 * can for a genuinely-checked missing file.
 *
 * Does NOT import scanPhasePlans / plan-scan.cjs — the owner consumes plan
 * counts from its caller when a caller needs them for a different question
 * (e.g. buildPhaseCompletionProjection's own `implementation_complete`); it
 * never re-derives or requires them itself.
 */
function isPhaseComplete(
  phaseDir: string,
  deps: IsPhaseCompleteDeps = {},
): { value: PhaseCompletionValue; scope: Scope } {
  const fsImpl: FsLike = deps.fs ?? defaultFsImpl;
  let readable = true;
  try {
    fsImpl.readdirSync(phaseDir);
  } catch {
    readable = false;
  }

  let verification: PhaseVerificationReading;
  let statusError: VerificationStatusError | undefined;
  try {
    verification = readVerificationStatus(phaseDir, {
      fs: deps.fs,
      phaseCleanCommitTimesMs: deps.phaseCleanCommitTimesMs,
      runtime: deps.runtime,
      phaseNumber: deps.phaseNumber,
      convention: deps.convention,
    });
  } catch (err) {
    if (!(err instanceof VerificationStatusError)) throw err;
    statusError = err;
    readable = false;
    verification = { status: null, next_action: err.message, next_command: '', route: '' };
  }

  return {
    value: {
      complete: verification.status === VERIFICATION_STATUS.PASSED,
      verification,
      ...(statusError ? { statusError } : {}),
    },
    scope: readable ? SCOPE.COMPLETE : SCOPE.UNREADABLE,
  };
}

/**
 * CLI command handler: resolve phaseDir against cwd, call readVerificationStatus,
 * emit via io.output().
 *
 * #5118: an out-of-set report status throws `VerificationStatusError` out of
 * here with nothing on stdout; gsd-tools.cjs translates it (once, centrally)
 * into ERROR_REASON `verification_status_invalid`. A nonexistent phase
 * directory is an ANSWER (`phase_dir_not_found`, `route: ''`, a `message`,
 * no `error` field — so `--pick status` prints it and the run is not
 * DEGRADED), not a failure.
 *
 * @param cwd         - Current working directory (used to resolve phaseDirArg).
 * @param phaseDirArg - Phase directory path (absolute or relative to cwd).
 * @param raw         - Whether to emit raw (non-JSON) output.
 */
function cmdVerificationStatus(cwd: string, phaseDirArg: string | undefined, raw: boolean): void {
  if (!phaseDirArg) {
    error('phase directory required for verification.status');
    return;
  }
  const phaseDir = path.resolve(cwd, phaseDirArg);
  const result = readVerificationStatus(phaseDir, { runtime: resolveRuntime(cwd) });
  output(result, raw);
}

/**
 * CLI command handler: resolve which `*-VERIFICATION.md` in `phaseDirArg` is
 * the phase's own report, via the shared `resolveVerificationFile` seam, and
 * emit its absolute path.
 *
 * #3492 F3: the ONE seam shell callers (verify-work.md's writer, transition.md's
 * awk reader) route through instead of hand-rolling `ls *-VERIFICATION.md |
 * head -1` / an awk glob scan — both of which pick alphabetically-first and so
 * diverge from every JS reader now pinned to the phase's own token.
 *
 * Emits `{ verification_file: "<absolute path>" | "" }` (empty when no
 * candidate resolves, including an unreadable directory). `raw` emits the
 * bare path string (possibly empty) so `VAR=$(gsd_run query
 * verification.resolve-file "$PHASE_DIR" --raw)` is directly assignable.
 *
 * #5118 (#4987 item 2): a path with no phase directory behind it adds the
 * marker `status: "phase_dir_not_found"` and a `message` — never an `error`
 * field (that would declare DEGRADED) — so it is distinguishable from an
 * existing directory with no report, where `""` alone keeps its meaning.
 *
 * @param cwd         - Current working directory (used to resolve phaseDirArg).
 * @param phaseDirArg - Phase directory path (absolute or relative to cwd).
 * @param raw         - Whether to emit raw (non-JSON) output.
 */
function cmdVerificationResolveFile(cwd: string, phaseDirArg: string | undefined, raw: boolean): void {
  if (!phaseDirArg) {
    error('phase directory required for verification.resolve-file');
    return;
  }
  const phaseDir = path.resolve(cwd, phaseDirArg);
  if (isPhaseDirNotFound(defaultFsImpl, phaseDir)) {
    output(
      {
        verification_file: '',
        status: VERIFICATION_STATUS.PHASE_DIR_NOT_FOUND,
        message: phaseDirNotFoundMessage(phaseDir),
      },
      raw,
      '',
    );
    return;
  }
  let verificationPath = '';
  try {
    const entries = fs.readdirSync(phaseDir);
    const phaseDirName = path.basename(phaseDir);
    const phaseToken = extractPhaseToken(phaseDirName);
    const verificationFile = resolveVerificationFile(entries, { allowBare: true, phaseToken, phaseDirName });
    if (verificationFile) {
      verificationPath = path.join(phaseDir, verificationFile);
    }
  } catch {
    verificationPath = '';
  }
  output({ verification_file: verificationPath }, raw, verificationPath);
}

/**
 * #4623: parse the argv tokens after `verification.fingerprint <phaseDir>`
 * into a covered-file list. The router hands over a raw positional slice,
 * so every `--files`-style form other `gsd-tools` verbs accept (`commit
 * --files a b`, `docs/CLI-TOOLS.md`) used to reach `computeCoveredDigest`
 * with the literal token `--files` — or an unsplit `"a,b"` — as a covered
 * path, and the whole command failed closed with "a covered file is
 * missing, unreadable, or escapes the project root". On the reporting
 * project that message convinced two people the digest was permanently
 * unrecomputable.
 *
 * Accepted, all equivalent and freely mixed:
 *   - bare positionals            `a b`            (the documented form, unchanged)
 *   - a single flag               `--files a`
 *   - a comma-separated value     `--files a,b`    (also `--files=a,b`)
 *   - a repeated flag             `--files a --files b`
 *
 * Only a `--files` VALUE is comma-split: a bare positional keeps its bytes,
 * so the documented form's behaviour on a comma-bearing filename is
 * unchanged. Any other `--flag` is an explicit usage error, never a path —
 * a mis-typed flag must not fail as "file missing" again. (`--raw` never
 * reaches here; the CLI entry point splices it out before routing.)
 */
function parseFingerprintFileArgs(tokens: readonly string[]): { files: string[] } | { error: string } {
  const files: string[] = [];
  const EMPTY_VALUE = '--files requires at least one path for verification.fingerprint (a path, or a comma-separated list)';
  const splitList = (value: string): string[] =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--files') {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: '--files requires a value for verification.fingerprint (a path, or a comma-separated list)' };
      }
      const list = splitList(value);
      // An empty or all-comma value is a usage error, never a silent no-op —
      // the caller would otherwise meet the generic zero-files error and go
      // looking for a missing path.
      if (list.length === 0) return { error: EMPTY_VALUE };
      files.push(...list);
      i++;
    } else if (token.startsWith('--files=')) {
      const list = splitList(token.slice('--files='.length));
      if (list.length === 0) return { error: EMPTY_VALUE };
      files.push(...list);
    } else if (token.startsWith('--')) {
      return {
        error: `unknown flag ${token} for verification.fingerprint (covered files are bare positionals or --files <a[,b]>, repeatable)`,
      };
    } else {
      files.push(token);
    }
  }
  return { files };
}

/**
 * CLI command handler (#4155): compute the covered-input fingerprint the
 * verifier embeds in VERIFICATION.md frontmatter (`covered_files`,
 * `covered_digest`). The verifier is an LLM agent, not a hashing engine —
 * this command does the deterministic math so the agent only has to name
 * the covered paths and copy the result into frontmatter.
 *
 * Emits `{ covered_files: <sorted deduped paths>, covered_digest: <digest> }`
 * on success. A covered path that is missing, unreadable, or escapes the
 * project root fails the WHOLE command (fail closed — a partial fingerprint
 * would be worse than none): `error()` is called and nothing is emitted.
 *
 * @param cwd         - Current working directory.
 * @param phaseDirArg - Phase directory path (absolute or relative to cwd);
 *                       its project root is the base covered paths resolve against.
 *                       Must be an existing directory (#4623): with the
 *                       phase dir omitted, the first covered file used to be
 *                       taken as the phase dir and the rest hashed — a
 *                       plausible digest over the wrong set, at exit 0.
 * @param fileArgs    - The argv tokens after the phase dir, parsed by
 *                       `parseFingerprintFileArgs`: covered-input paths
 *                       relative to the project root, bare or via `--files`.
 * @param raw         - Whether to emit raw (non-JSON) output: just the
 *                       `covered_digest` string, so `VAR=$(gsd_run query
 *                       verification.fingerprint "$PHASE_DIR" ... --raw)` is
 *                       directly assignable. #5095 (ADR-5057 Phase 2): `raw`
 *                       returning only the digest is safe even though the
 *                       emitted `covered_files` is a SUPERSET of the caller's
 *                       declared list — the v3 digest is computed over
 *                       `canonicalize(declared ∪ phaseArtifactPaths)` on BOTH
 *                       the emit side (here) and the check side
 *                       (`readVerificationStatus`), so a `--raw` caller that
 *                       writes its OWN declared list (without enumerating
 *                       plans/summaries) alongside the raw digest still
 *                       matches — the checker adds the identical union.
 */
function cmdVerificationFingerprint(
  cwd: string,
  phaseDirArg: string | undefined,
  fileArgs: readonly string[],
  raw: boolean,
): void {
  if (!phaseDirArg) {
    error('phase directory required for verification.fingerprint');
    return;
  }
  const phaseDir = path.resolve(cwd, phaseDirArg);
  let phaseDirIsDir = false;
  try {
    phaseDirIsDir = fs.statSync(phaseDir).isDirectory();
  } catch {
    // not found → not a directory
  }
  if (!phaseDirIsDir) {
    error(
      `phase directory not found: ${phaseDirArg} — verification.fingerprint takes the phase directory first, then the covered files`,
    );
    return;
  }
  const parsed = parseFingerprintFileArgs(fileArgs);
  if ('error' in parsed) {
    error(parsed.error);
    return;
  }
  const files = parsed.files;
  if (files.length === 0) {
    error('at least one covered file required for verification.fingerprint');
    return;
  }
  const projectRoot = resolveProjectRoot(phaseDir);
  // canonicalizeCoveredFiles here is for `deriveCoveredDigest`'s
  // `coveredFiles` argument — it canonicalizes internally too (it must, for
  // callers like readVerificationStatus that pass raw, un-canonicalized
  // frontmatter values), so passing an already-canonical list keeps that
  // internal pass a cheap no-op rather than a second meaningfully different
  // canonicalization.
  const declaredCanonical = canonicalizeCoveredFiles(files, { version: FINGERPRINT_VERSION });
  // #5095 (R1/R2/R7, ADR-5057 Phase 2): ONE call derives both the emitted
  // `covered_files` (`.files`, the declared set unioned with the phase's own
  // live artifacts) and the hashed digest (`.digest`) — the CLI no longer
  // runs `phaseArtifactPaths` itself and again inside the digest computation,
  // which used to leave a race window where the two calls could see a
  // different phase directory and disagree. An artifact-resolution failure
  // fails the WHOLE command (fail closed: the emitter cannot vouch for a set
  // it could not fully see).
  const derivation = deriveCoveredDigest(projectRoot, declaredCanonical, FINGERPRINT_VERSION, { phaseDir });
  if (!derivation.ok) {
    error(`could not compute fingerprint — ${derivation.reason}`);
    return;
  }
  const unionSorted = derivation.files;
  if (unionSorted.length === 0) {
    error('at least one covered file required for verification.fingerprint');
    return;
  }
  const digest = derivation.digest;
  if (digest === null) {
    // #4623: name the one null that is NOT a bad path — a declaration made
    // only of shared planning documents (with no other evidence) hashes
    // nothing under v2+, and the generic message below would send the caller
    // looking for a missing file that is not missing. Discriminated AFTER
    // the versioned attempt, and only when a v1 pass over the same list
    // (which hashes, and therefore validates, every path) succeeds: an
    // all-shared list with a missing or directory member is a bad path
    // first, and gets the generic message. #5095 (R5): a phase WITH real
    // artifacts never reaches this branch — the union above already supplied
    // evidence — so this error is reachable only when every declared path is
    // a shared planning doc AND the phase has no plans/summaries of its own.
    const sharedRoots = sharedRootsFor(projectRoot, phaseDir, derivation.mappedPhaseDir);
    if (
      unionSorted.every((f) => isSharedPlanningDoc(f, sharedRoots)) &&
      computeCoveredDigest(projectRoot, unionSorted, 1) !== null
    ) {
      error(
        `could not compute fingerprint — every covered file is a repo-wide planning document (direct children of ${sharedRoots.join(', ')} never enter the digest); declare the phase's own artifacts and implementation files`,
      );
      return;
    }
    error('could not compute fingerprint — a covered file is missing, unreadable, or escapes the project root');
    return;
  }
  output({ covered_files: unionSorted, covered_digest: digest }, raw, digest);
}

// ─── verification.append-audit (#5105 R3) ──────────────────────────────────

/**
 * Render a single `## <heading> <date>` block followed by a `| Metric |
 * Count |` table over `rows` — the exact shape `secure-phase.md` /
 * `validate-phase.md` compose by hand today (#4887 Defect 2, #4981).
 */
function renderAuditBlock(heading: string, date: string, rows: Record<string, unknown>): string {
  const lines = [`## ${heading} ${date}`, '', '| Metric | Count |', '|---|---|'];
  for (const [k, v] of Object.entries(rows)) lines.push(`| ${k} | ${String(v)} |`);
  return lines.join('\n') + '\n';
}

interface AuditAppendResult {
  appended: boolean;
  content: string;
}

/**
 * #5105 (S4): parse a block body's `| Metric | Count |`-shaped table into a
 * plain metric→count string map, addressed by the table's ACTUAL first/second
 * column (never a hard-coded `Metric`/`Count` name) so a legacy block with
 * different header text still compares. Whitespace/separator-width tolerant
 * by construction — `parseMarkdownTable` trims every cell and accepts any
 * `-{1,}` delimiter width. Returns `null` when the body carries no parseable
 * 2+-column table (no prior block to compare against).
 */
function parseAuditTableRows(bodyText: string): Record<string, string> | null {
  const parsed = parseMarkdownTable(bodyText);
  if (!parsed.ok || parsed.value.columns.length < 2) return null;
  const [metricCol, countCol] = parsed.value.columns;
  const map: Record<string, string> = {};
  for (const row of parsed.value.rows) {
    map[row[metricCol]] = String(row[countCol]).trim();
  }
  return map;
}

/** Order-insensitive equality over two metric→count maps. */
function auditRowsEqual(live: Record<string, string> | null, candidate: Record<string, string>): boolean {
  if (!live) return false;
  const liveKeys = Object.keys(live);
  const candidateKeys = Object.keys(candidate);
  if (liveKeys.length !== candidateKeys.length) return false;
  return liveKeys.every((k) => Object.prototype.hasOwnProperty.call(candidate, k) && live[k] === candidate[k]);
}

/**
 * #5105 R3 — pure core of `verification.append-audit`.
 *
 * Finds the LAST `## <heading> <date>` block in `content` — a level-2
 * heading whose text matches `^<heading> (\d{4}-\d{2}-\d{2})\b` — via the
 * shared, fence-aware `tokenizeHeadings`/`collectSection` primitives (#5105
 * S6) instead of a hand-rolled `^## ` scan: a `## <heading> <date>`-looking
 * line inside a fenced code block is not a heading and cannot be selected,
 * and a heading whose trailing word ISN'T a date (e.g. the template's bare
 * `## Security Audit Trail`) is not matched either (#5105 S4 — the anchored
 * heading date shape, not `(\S+)`, is what excludes it).
 *
 * Comparison (#5105 S4) is over the block's PARSED table rows
 * (`parseAuditTableRows`/`auditRowsEqual`) — whitespace/separator-width
 * insensitive, order-insensitive, and tolerant of an optional blank line
 * after the heading — never a byte-for-byte body string compare. Identical
 * rows on the last block → `{ appended: false }`, no write. Different rows
 * (or no prior block) → appends the new block at the end and returns
 * `{ appended: true }`.
 *
 * Deliberately compares against the LAST block only, never any earlier one —
 * a re-audit that regresses back to an earlier count must still append.
 *
 * `date` defaults through the `clock` seam (default: the global `Date`
 * constructor) rather than a bare `new Date()` call, so a caller can pin the
 * date deterministically — directly (pass `clock`) or via `node:test`
 * `mock.timers` (which replaces global `Date`, picked up automatically since
 * the default is evaluated per call).
 */
function planAuditAppend(
  content: string,
  { heading, rows, date, clock = Date }: { heading: string; rows: Record<string, unknown>; date?: string; clock?: DateConstructor },
): AuditAppendResult {
  const resolvedDate = date ?? new clock().toISOString().slice(0, 10);
  const escapedHeading = escapeRegex(heading);
  const headingRe = new RegExp(`^${escapedHeading} (\\d{4}-\\d{2}-\\d{2})\\b`);
  const matchingHeadings = tokenizeHeadings(content).filter((h) => h.level === 2 && headingRe.test(h.text));
  const newBlock = renderAuditBlock(heading, resolvedDate, rows);

  const newRowsMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(rows)) newRowsMap[k] = String(v);

  if (matchingHeadings.length > 0) {
    const last = matchingHeadings[matchingHeadings.length - 1];
    const section = collectSection(content, (h) => h.offset === last.offset);
    const liveRows = section ? parseAuditTableRows(section.body) : null;
    if (auditRowsEqual(liveRows, newRowsMap)) {
      return { appended: false, content };
    }
  }

  const trimmed = content.replace(/\s+$/, '');
  const appendedContent = (trimmed.length > 0 ? trimmed + '\n\n' : '') + newBlock;
  return { appended: true, content: appendedContent };
}

/** Reject a `\r`, `\n`, or `|` — any of the three would corrupt the rendered heading/table shape. */
function hasForbiddenAuditChar(s: string): boolean {
  return /[\r\n|]/.test(s);
}

/** `rows` values must be a non-negative integer, as either a JSON number or an all-digit string. */
function isNonNegativeIntegerValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0;
  if (typeof v === 'string') return /^\d+$/.test(v);
  return false;
}

/** Reject a value carrying leading/trailing whitespace — a heading or row key
 * with padding would not match `parseMarkdownTable`'s trimmed reads on a
 * later append, so the same key would silently fail to be recognized as the
 * "already present" row (re-review finding 6). */
function hasLeadingOrTrailingWhitespace(s: string): boolean {
  return s !== s.trim();
}

/** True calendar-date check for `--date` (re-review finding 9): rejects an
 * out-of-range month/day (e.g. `2026-99-99`) or a day that does not exist in
 * that month (e.g. `2026-02-30`), which `/^\d{4}-\d{2}-\d{2}$/` alone lets
 * through — `Date.UTC` normalizes overflow instead of raising, so the parsed
 * fields must be compared back against the input. */
function isRealCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * #5105 S3 — validate `verification.append-audit` input shape before it ever
 * reaches `planAuditAppend`/the file. `--rows` being valid JSON (checked by
 * the caller before this runs) is necessary but not sufficient: a newline,
 * `\r`, or `|` in the heading or any row key/value would corrupt the
 * rendered `## heading date` line or `| key | value |` row, and a non-integer
 * or negative count is not a countable metric.
 */
function validateAuditAppendInput(
  heading: string,
  rows: Record<string, unknown>,
  date: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (hasForbiddenAuditChar(heading)) {
    return { ok: false, reason: '--heading must not contain a newline, carriage return, or |' };
  }
  if (hasLeadingOrTrailingWhitespace(heading)) {
    return { ok: false, reason: '--heading must not have leading or trailing whitespace' };
  }
  for (const [key, value] of Object.entries(rows)) {
    if (hasForbiddenAuditChar(key)) {
      return { ok: false, reason: `--rows key ${JSON.stringify(key)} must not contain a newline, carriage return, or |` };
    }
    if (hasLeadingOrTrailingWhitespace(key)) {
      return { ok: false, reason: `--rows key ${JSON.stringify(key)} must not have leading or trailing whitespace` };
    }
    if (typeof value === 'string' && hasForbiddenAuditChar(value)) {
      return { ok: false, reason: `--rows value for ${JSON.stringify(key)} must not contain a newline, carriage return, or |` };
    }
    if (!isNonNegativeIntegerValue(value)) {
      return { ok: false, reason: `--rows value for ${JSON.stringify(key)} must be a non-negative integer` };
    }
  }
  if (date !== undefined && !isRealCalendarDate(date)) {
    return { ok: false, reason: '--date must be a real calendar date in YYYY-MM-DD form' };
  }
  return { ok: true };
}

/**
 * #5105 S2 — case-insensitive re-implementation of `isVerificationReportPath`'s
 * shape. That helper is deliberately case-SENSITIVE (matching
 * `resolveVerificationFile`'s own convention — see its doc comment), so it
 * cannot be reused directly for a containment refusal that must catch a
 * lowercase `07-verification.md` too.
 */
function isVerificationReportBasenameCI(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower === 'verification.md' || lower.endsWith('-verification.md');
}

/** #5105 S2 — the only two shapes `verification.append-audit` may target. */
function isAllowedAuditTargetBasenameCI(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.endsWith('-security.md') || lower.endsWith('-validation.md');
}

/**
 * CLI command handler (#5105 R3): `verification.append-audit <file>
 * --heading <H> --rows '<json {metric:count}>' [--date <YYYY-MM-DD>]`.
 *
 * Never reads or writes `covered_files`/`covered_digest` (#4981 invariant
 * 5) — a genuinely changed count publishes and stales any report that covers
 * `file`; nothing here ever restamps it.
 *
 * #5105 S2: `file` is resolved through the same `requireSafePath(...,
 * PathAcceptance.AbsoluteInsideRoot)` seam `uat.complete-session` uses —
 * refusing an absolute-outside-root target or a `../` escape by throwing
 * before any read/write is attempted (uncaught here, matching every other
 * `requireSafePath` call site in this codebase — a top-level command
 * dispatcher turns the throw into a failed exit). The REAL (symlink-resolved)
 * basename is then checked twice, case-insensitively: it must not be a
 * verification report itself, and it must be a `*-SECURITY.md` or
 * `*-VALIDATION.md` file — the only two artifact kinds this command may
 * mutate.
 */
function cmdVerificationAppendAudit(
  cwd: string,
  fileArg: string | undefined,
  argTokens: readonly string[],
  raw: boolean,
): void {
  if (!fileArg) {
    error('file required for verification.append-audit');
    return;
  }
  const { heading, rows: rowsArg, date: dateArg } = parseNamedArgsOrExit(
    argTokens as string[],
    { valueFlags: ['heading', 'rows', 'date'], positionals: 0 },
    error,
  );
  if (!heading) {
    error('--heading required for verification.append-audit');
    return;
  }
  if (!rowsArg) {
    error('--rows required for verification.append-audit');
    return;
  }
  let rows: Record<string, unknown>;
  try {
    const parsedRows: unknown = JSON.parse(rowsArg as string);
    if (!parsedRows || typeof parsedRows !== 'object' || Array.isArray(parsedRows)) {
      throw new Error('not an object');
    }
    rows = parsedRows as Record<string, unknown>;
  } catch {
    error('--rows must be a JSON object for verification.append-audit');
    return;
  }
  const date = (dateArg as string | null) ?? undefined;
  const validation = validateAuditAppendInput(heading as string, rows, date);
  if (!validation.ok) {
    error(validation.reason);
    return;
  }

  const resolvedPath = requireSafePath(fileArg, cwd, 'verification.append-audit file', PathAcceptance.AbsoluteInsideRoot);
  const realBasename = path.basename(resolvedPath);
  if (isVerificationReportBasenameCI(realBasename)) {
    error('verification.append-audit refuses a verification report path');
    return;
  }
  if (!isAllowedAuditTargetBasenameCI(realBasename)) {
    error('verification.append-audit target must be a *-SECURITY.md or *-VALIDATION.md file');
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, 'utf-8');
  } catch {
    error(`file not found: ${fileArg}`);
    return;
  }
  const result = planAuditAppend(content, { heading: heading as string, rows, date });
  if (result.appended) {
    fs.writeFileSync(resolvedPath, result.content);
  }
  output({ appended: result.appended }, raw);
}

const verificationModule = {
  VERIFICATION_STATUS,
  VERIFIER_STATUSES,
  VERIFICATION_ROUTES,
  isVerificationStatus,
  assertVerificationStatus,
  VerificationStatusError,
  VERIFICATION_STATUS_ERROR_CODE,
  failOnVerificationStatusError,
  firstStatusError,
  reportStatusOf,
  isReportContained,
  routeResult,
  findVerificationStatusError,
  defaultPhaseCleanCommitTimesMs,
  resolvePhaseArtifactFile,
  resolveVerificationFile,
  resolveUatFile,
  findStaleVerificationSummary,
  readVerificationStatus,
  isPhaseComplete,
  cmdVerificationStatus,
  cmdVerificationResolveFile,
  computeCoveredDigest,
  sharedPlanningRoots,
  isSharedPlanningDoc,
  isVerificationReportPath,
  parseFingerprintVersion,
  parseFingerprintFileArgs,
  cmdVerificationFingerprint,
  planAuditAppend,
  cmdVerificationAppendAudit,
};
// Namespace merge (same binding name as the value above) is how this
// `export =` module exposes the closed enum's TYPES beside its runtime export
// (the planning-scope.cts precedent): `import type v = require(...)` then
// `v.VerificationStatus`.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace verificationModule {
  export { VerificationStatus, VerifierStatus, VerificationStatusResult, RouteCommand, PhaseVerificationReading };
}

export = verificationModule;
