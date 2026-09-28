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

// ─── Closed vocabularies ───────────────────────────────────────────────────

/** The lifecycle ladder, lowest rung first. */
export const PHASE_STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  PLANNED: 'PLANNED',
  IN_PROGRESS: 'IN_PROGRESS',
  EXECUTED: 'EXECUTED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  COMPLETE: 'COMPLETE',
} as const);

export type PhaseStatus = (typeof PHASE_STATUS)[keyof typeof PHASE_STATUS];

/**
 * The three-value wire vocabulary published by `.planning/state.json`
 * (`phases[].status`) and the Workstream Inventory (`PhaseStatus.status`).
 */
export const WIRE_STATUS = Object.freeze({
  COMPLETE: 'complete',
  IN_PROGRESS: 'in_progress',
  PENDING: 'pending',
} as const);

export type WireStatus = (typeof WIRE_STATUS)[keyof typeof WIRE_STATUS];

/**
 * The ROADMAP `## Progress` table Status-cell vocabulary: the template's
 * `Not started | In progress | Complete | Deferred` plus the `Planned` word
 * `roadmap update-plan-progress` writes. `In Progress` is spelled the way the
 * writers have always written it.
 */
export const ROADMAP_STATUS_TOKEN = Object.freeze({
  NOT_STARTED: 'Not started',
  PLANNED: 'Planned',
  IN_PROGRESS: 'In Progress',
  COMPLETE: 'Complete',
  DEFERRED: 'Deferred',
} as const);

export type RoadmapStatusToken = (typeof ROADMAP_STATUS_TOKEN)[keyof typeof ROADMAP_STATUS_TOKEN];

const LADDER: readonly PhaseStatus[] = Object.freeze([
  PHASE_STATUS.NOT_STARTED,
  PHASE_STATUS.PLANNED,
  PHASE_STATUS.IN_PROGRESS,
  PHASE_STATUS.EXECUTED,
  PHASE_STATUS.NEEDS_REVIEW,
  PHASE_STATUS.COMPLETE,
]);

const LADDER_RANK: ReadonlyMap<string, number> = new Map(LADDER.map((s, i) => [s, i]));

function assertPhaseStatus(value: unknown, where: string): asserts value is PhaseStatus {
  if (typeof value !== 'string' || !LADDER_RANK.has(value)) {
    throw new TypeError(`${where}: ${JSON.stringify(value)} is not a PHASE_STATUS value`);
  }
}

function assertCount(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`phaseStatusFromFacts: ${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

// ─── The ladder ────────────────────────────────────────────────────────────

export interface PhaseStatusFacts {
  /** Live plan count from `scanPhasePlans` (ADR-3180 §7.5). */
  planCount: number;
  /** Matched summary count from `scanPhasePlans` (ADR-3180 §7.5). */
  summaryCount: number;
  /** The completion verdict — `isPhaseComplete(...).value.complete` (§7.4), or a caller's stricter write gate built on it. */
  complete: boolean;
  /** `isPhaseComplete(...).value.verification.status`, or null when the caller has none. Only `human_needed` changes the ladder. */
  verificationStatus: string | null;
}

/**
 * The ladder. First matching rung wins:
 *   complete                     → COMPLETE     (disk-strict: no plan precondition, #3168)
 *   no plans                     → NOT_STARTED
 *   no summaries                 → PLANNED
 *   fewer summaries than plans   → IN_PROGRESS
 *   verification `human_needed`  → NEEDS_REVIEW
 *   otherwise                    → EXECUTED     (gaps_found, stale, missing, unknown, unparseable)
 *
 * Completion comes ONLY from `complete`. The ladder never restates a
 * summary-versus-plan completion comparison (scripts/lint-completion-predicate-drift.cjs shape (c)).
 */
export function phaseStatusFromFacts(facts: PhaseStatusFacts): PhaseStatus {
  if (facts === null || typeof facts !== 'object') {
    throw new TypeError('phaseStatusFromFacts: facts object required');
  }
  const { planCount, summaryCount, complete, verificationStatus } = facts;
  assertCount(planCount, 'planCount');
  assertCount(summaryCount, 'summaryCount');
  if (typeof complete !== 'boolean') {
    throw new TypeError(`phaseStatusFromFacts: complete must be a boolean, got ${JSON.stringify(complete)}`);
  }
  if (complete) return PHASE_STATUS.COMPLETE;
  if (planCount === 0) return PHASE_STATUS.NOT_STARTED;
  if (summaryCount === 0) return PHASE_STATUS.PLANNED;
  if (summaryCount < planCount) return PHASE_STATUS.IN_PROGRESS;
  if (verificationStatus === 'human_needed') return PHASE_STATUS.NEEDS_REVIEW;
  return PHASE_STATUS.EXECUTED;
}

// ─── The I/O entry point ───────────────────────────────────────────────────

type VerificationMod = typeof import('./verification.cjs');
type PlanScanMod = typeof import('./plan-scan.cjs');
type Scope = import('./planning-scope.cjs').Scope;
type PhaseCompletion = ReturnType<VerificationMod['isPhaseComplete']>;

type IsPhaseCompleteDeps = NonNullable<Parameters<VerificationMod['isPhaseComplete']>[1]>;

export interface PhaseStatusDeps {
  /** The repo's resolved `phase_id_convention`, threaded into `isPhaseComplete` (#612). */
  convention?: string | null;
  /** fs seam, threaded into `isPhaseComplete`. */
  fs?: IsPhaseCompleteDeps['fs'];
  /** Per-phase clean-commit-time resolver, threaded into `isPhaseComplete`. */
  phaseCleanCommitTimesMs?: IsPhaseCompleteDeps['phaseCleanCommitTimesMs'];
}

export interface PhaseStatusValue {
  status: PhaseStatus;
  planCount: number;
  summaryCount: number;
  /** `isPhaseComplete`'s full verification routing result. */
  verification: PhaseCompletion['value']['verification'];
}

const SCOPE_SEVERITY: Readonly<Record<string, number>> = Object.freeze({
  complete: 0,
  truncated: 1,
  unscoped: 2,
  unreadable: 3,
});

let _verification: VerificationMod | null = null;
let _planScan: PlanScanMod | null = null;

function owners(): { verification: VerificationMod; planScan: PlanScanMod } {
  /* eslint-disable @typescript-eslint/no-require-imports */
  if (!_verification) _verification = require('./verification.cjs') as VerificationMod;
  if (!_planScan) _planScan = require('./plan-scan.cjs') as PlanScanMod;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { verification: _verification, planScan: _planScan };
}

/**
 * What state is the phase in `phaseDir` in? Composes only ADR-3180's §7
 * owners. `scope` is the worse of the plan scan's and the completion read's
 * scopes, so a caller can tell "not started" from "could not look".
 */
export function phaseStatus(phaseDir: string, deps: PhaseStatusDeps = {}): { value: PhaseStatusValue; scope: Scope } {
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
export function foldPhaseStatuses(a: PhaseStatus, b: PhaseStatus): PhaseStatus {
  assertPhaseStatus(a, 'foldPhaseStatuses');
  assertPhaseStatus(b, 'foldPhaseStatuses');
  return (LADDER_RANK.get(a) as number) >= (LADDER_RANK.get(b) as number) ? a : b;
}

// ─── Projections ───────────────────────────────────────────────────────────

export type PendingWord = 'Pending' | 'Not Started';

const DISPLAY_LABEL: Readonly<Record<PhaseStatus, string>> = Object.freeze({
  [PHASE_STATUS.NOT_STARTED]: 'Not Started',
  [PHASE_STATUS.PLANNED]: 'Planned',
  [PHASE_STATUS.IN_PROGRESS]: 'In Progress',
  [PHASE_STATUS.EXECUTED]: 'Executed',
  [PHASE_STATUS.NEEDS_REVIEW]: 'Needs Review',
  [PHASE_STATUS.COMPLETE]: 'Complete',
});

/**
 * The label `progress`, `stats`, `init plan-phase` and `gsd-health` show. The
 * NOT_STARTED word is the caller's display choice (`progress` and `init` say
 * `Pending`, `stats` and the health rule say `Not Started`).
 */
export function toDisplayLabel(status: PhaseStatus, opts: { pendingWord?: PendingWord } = {}): string {
  assertPhaseStatus(status, 'toDisplayLabel');
  const pendingWord = opts.pendingWord ?? 'Not Started';
  if (pendingWord !== 'Pending' && pendingWord !== 'Not Started') {
    throw new TypeError(`toDisplayLabel: pendingWord must be 'Pending' or 'Not Started', got ${JSON.stringify(pendingWord)}`);
  }
  return status === PHASE_STATUS.NOT_STARTED ? pendingWord : DISPLAY_LABEL[status];
}

/** `pending` means nothing is planned yet; every rung between that and COMPLETE is `in_progress`. */
export function toWireStatus(status: PhaseStatus): WireStatus {
  assertPhaseStatus(status, 'toWireStatus');
  if (status === PHASE_STATUS.COMPLETE) return WIRE_STATUS.COMPLETE;
  if (status === PHASE_STATUS.NOT_STARTED) return WIRE_STATUS.PENDING;
  return WIRE_STATUS.IN_PROGRESS;
}

/** The word a ROADMAP writer puts in the Status cell for this rung. */
export function toRoadmapStatusCell(status: PhaseStatus): RoadmapStatusToken {
  assertPhaseStatus(status, 'toRoadmapStatusCell');
  switch (status) {
    case PHASE_STATUS.COMPLETE: return ROADMAP_STATUS_TOKEN.COMPLETE;
    case PHASE_STATUS.PLANNED: return ROADMAP_STATUS_TOKEN.PLANNED;
    case PHASE_STATUS.NOT_STARTED: return ROADMAP_STATUS_TOKEN.NOT_STARTED;
    default: return ROADMAP_STATUS_TOKEN.IN_PROGRESS;
  }
}

/**
 * `roadmap analyze` / `init manager`'s `disk_status`. Below NOT_STARTED the
 * word records which pre-planning artifacts exist. (`no_directory` is the
 * callers' own word for "no directory matched" — there is no phase to ask.)
 */
export function toDiskStatus(status: PhaseStatus, artifacts: { hasResearch: boolean; hasContext: boolean }): string {
  assertPhaseStatus(status, 'toDiskStatus');
  switch (status) {
    case PHASE_STATUS.COMPLETE: return 'complete';
    case PHASE_STATUS.NEEDS_REVIEW:
    case PHASE_STATUS.EXECUTED: return 'executed';
    case PHASE_STATUS.IN_PROGRESS: return 'partial';
    case PHASE_STATUS.PLANNED: return 'planned';
    default:
      if (artifacts.hasResearch) return 'researched';
      if (artifacts.hasContext) return 'discussed';
      return 'empty';
  }
}

/** `init`'s `completion_status`: complete / executed / incomplete. */
export function toCompletionStatus(status: PhaseStatus): 'complete' | 'executed' | 'incomplete' {
  assertPhaseStatus(status, 'toCompletionStatus');
  if (status === PHASE_STATUS.COMPLETE) return 'complete';
  if (status === PHASE_STATUS.EXECUTED || status === PHASE_STATUS.NEEDS_REVIEW) return 'executed';
  return 'incomplete';
}

/** `init progress`'s per-phase `status`. */
export function toProgressStatus(status: PhaseStatus, artifacts: { hasResearch: boolean }): string {
  assertPhaseStatus(status, 'toProgressStatus');
  switch (status) {
    case PHASE_STATUS.COMPLETE: return 'complete';
    case PHASE_STATUS.NEEDS_REVIEW:
    case PHASE_STATUS.EXECUTED: return 'executed';
    case PHASE_STATUS.IN_PROGRESS:
    case PHASE_STATUS.PLANNED: return 'in_progress';
    default: return artifacts.hasResearch ? 'researched' : 'pending';
  }
}

// ─── ROADMAP Status cell reader ────────────────────────────────────────────

// Leading token of a trimmed cell, case-insensitive, a whitespace run allowed
// inside the two-word tokens, and `(?!\w)` so `Completed` / `Planning` are not
// tokens. #4925 lets operator prose follow the token; that prose is ignored.
const CELL_TOKEN_RE = /^(not\s+started|planned|in\s+progress|complete|deferred)(?!\w)/i;

const TOKEN_BY_KEY: Readonly<Record<string, RoadmapStatusToken>> = Object.freeze({
  'not started': ROADMAP_STATUS_TOKEN.NOT_STARTED,
  planned: ROADMAP_STATUS_TOKEN.PLANNED,
  'in progress': ROADMAP_STATUS_TOKEN.IN_PROGRESS,
  complete: ROADMAP_STATUS_TOKEN.COMPLETE,
  deferred: ROADMAP_STATUS_TOKEN.DEFERRED,
});

/**
 * Read a Status cell's leading token. Returns the canonical token and the raw
 * text it matched (writers compare `text` to decide whether a rewrite is a
 * no-op), or null when the cell has no leading token. Never throws.
 */
export function matchRoadmapStatusCell(cell: unknown): { token: RoadmapStatusToken; text: string } | null {
  if (typeof cell !== 'string') return null;
  const m = CELL_TOKEN_RE.exec(cell.trim());
  if (!m) return null;
  const key = m[1].toLowerCase().replace(/\s+/g, ' ');
  return { token: TOKEN_BY_KEY[key], text: m[1] };
}

/**
 * A Status cell as a wire value. `Deferred`, `Not started`, a cell with no
 * leading token, and a non-string all read `pending` — an unrecognized cell
 * never becomes a fourth wire value. Inverse of `toRoadmapStatusCell` under
 * `toWireStatus` (ADR-5057 Phase 1 property).
 */
export function parseRoadmapStatusCell(cell: unknown): WireStatus {
  const m = matchRoadmapStatusCell(cell);
  if (m === null) return WIRE_STATUS.PENDING;
  switch (m.token) {
    case ROADMAP_STATUS_TOKEN.COMPLETE: return WIRE_STATUS.COMPLETE;
    case ROADMAP_STATUS_TOKEN.IN_PROGRESS:
    case ROADMAP_STATUS_TOKEN.PLANNED: return WIRE_STATUS.IN_PROGRESS;
    default: return WIRE_STATUS.PENDING;
  }
}
