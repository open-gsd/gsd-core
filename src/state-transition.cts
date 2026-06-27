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

// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatter = require('./frontmatter.cjs');
import { stateReplaceField, stateExtractField, stateReplaceFieldIfTemplate, stateReplaceFieldWithFallback } from './state-document.cjs';
import { KNOWN_TEMPLATE_DEFAULTS } from './state-document.cjs';
import { tokenizeHeadings } from './markdown-sectionizer.cjs';
import { deriveProgressFromRoadmap, clampPercent } from './phase-lifecycle.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');

const { extractFrontmatter, reconstructFrontmatter } = frontmatter;
const { escapeRegex } = phaseIdMod;

// Stop predicate for section-body slicing: a level-2+ heading ends the section.
const STOP_H2_PLUS = (lv: number): boolean => lv >= 2;

// ----------------------------------------------------------------------------
// Field-classification table (ADR-1769 §4)
// ----------------------------------------------------------------------------
//
// Two-column shape per ADR: `{ source, preservation }`. Source alone is
// insufficient because two fields can share a source but need different
// preservation rules (e.g. `current_phase` and `last_activity` are both
// `derived-from-body`, but `current_phase` preserves-when-unchanged per #1230
// while `last_activity` always re-derives). Codex review of Phase 1 caught
// the collapsed-enum shape as a substrate defect that wouldn't survive
// Phases 2–7.

export type FieldSource =
  | 'body' // value is derived from a body field (Phase:, Status:, etc.)
  | 'disk' // value is derived from a disk scan (.planning/phases/* counts)
  | 'external' // value is derived from an external file (ROADMAP.md milestone)
  | 'curated' // value is set by humans/tools; preserve unless explicitly overwritten
  | 'free'; // caller's word is law (no preservation)

export type FieldPreservation =
  | 'derive' // always re-derive from source
  | 'preserve-when-unchanged' // #1230 delta heuristic: keep existing if body source field unchanged
  | 'preserve-always' // never overwrite unless the caller explicitly names this field
  | 'preserve-if-placeholder' // overwrite only when derived value is a known placeholder (#948)
  | 'clear'; // remove the field entirely

export type FieldClassification = { source: FieldSource; preservation: FieldPreservation };

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
export const FIELD_CLASSIFICATION: Readonly<Record<string, FieldClassification>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, FieldClassification>,
    {
      // Schema
      gsd_state_version: { source: 'free', preservation: 'derive' } as FieldClassification,

      // Milestone (external — from ROADMAP.md)
      milestone: { source: 'external', preservation: 'preserve-if-placeholder' } as FieldClassification,
      milestone_name: { source: 'external', preservation: 'preserve-if-placeholder' } as FieldClassification,

      // Phase / plan position (body-derived)
      current_phase: { source: 'body', preservation: 'preserve-when-unchanged' } as FieldClassification,
      current_phase_name: { source: 'curated', preservation: 'preserve-always' } as FieldClassification, // #1743, #1695
      current_plan: { source: 'body', preservation: 'preserve-when-unchanged' } as FieldClassification,

      // Status / lifecycle (body-derived; #1230 delta heuristic applies)
      status: { source: 'body', preservation: 'preserve-when-unchanged' } as FieldClassification,
      stopped_at: { source: 'body', preservation: 'preserve-when-unchanged' } as FieldClassification,
      paused_at: { source: 'body', preservation: 'preserve-when-unchanged' } as FieldClassification,

      // Activity log
      last_updated: { source: 'free', preservation: 'derive' } as FieldClassification, // realClock.nowIso()
      last_activity: { source: 'body', preservation: 'derive' } as FieldClassification, // always refresh on transition
      last_activity_desc: { source: 'body', preservation: 'preserve-when-unchanged' } as FieldClassification,

      // Progress block (disk-derived, except the curated progress ratchet)
      progress: { source: 'curated', preservation: 'preserve-always' } as FieldClassification, // #3242, #1446
      'progress.total_phases': { source: 'disk', preservation: 'derive' } as FieldClassification,
      'progress.completed_phases': { source: 'disk', preservation: 'derive' } as FieldClassification,
      'progress.total_plans': { source: 'disk', preservation: 'derive' } as FieldClassification,
      'progress.completed_plans': { source: 'disk', preservation: 'derive' } as FieldClassification,
      'progress.percent': { source: 'disk', preservation: 'derive' } as FieldClassification,
    } satisfies Record<string, FieldClassification>,
  ),
);

/**
 * Own-property classification lookup. Returns `null` for unknown fields
 * (including inherited prototype methods like `toString`/`valueOf`).
 */
export function getFieldClassification(field: string): FieldClassification | null {
  if (!Object.prototype.hasOwnProperty.call(FIELD_CLASSIFICATION, field)) return null;
  return FIELD_CLASSIFICATION[field];
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
export const STATE_MD_SECTIONS = {
  projectReference: '## Project Reference',
  currentPosition: '## Current Position',
  performanceMetrics: '## Performance Metrics',
  accumulatedContext: '## Accumulated Context',
  deferredItems: '## Deferred Items',
  sessionContinuity: '## Session Continuity',
} as const;

// ----------------------------------------------------------------------------
// Intent + deps + result types (ADR-1769 §3)
// ----------------------------------------------------------------------------

export type ProgressRecord = Record<string, unknown>;

export type StateTransitionDeps = {
  progressProvider: () => ProgressRecord | null;
  clock: { today: () => string; nowIso: () => string };
  /**
   * Roadmap content provider for transitions that re-derive milestone-wide
   * progress from ROADMAP.md (completePhase). Optional: transitions that don't
   * consult the roadmap ignore it. Injected (not imported) so the core stays
   * pure and testable without disk I/O.
   */
  roadmapProvider?: () => string | null;
};

export type StateTransitionIntent =
  | { kind: 'beginPhase'; phaseNumber: string | number; phaseName: string | null; planCount: number | null }
  | { kind: 'advancePlan' }
  | {
      kind: 'completePhase';
      phaseNum: string;
      /** Next phase number, or null when completing the final phase. */
      nextPhaseNum: string | null;
      /** Display name for the next phase (may be null when unknown). */
      nextPhaseName: string | null;
      /** True when this is the final phase in the milestone. */
      isLastPhase: boolean;
      planCount: number;
      summaryCount: number;
    }
  | { kind: 'plannedPhase'; phaseNumber: string | number; planCount: number | null }
  | { kind: 'milestoneSwitch'; version: string; name: string }
  | {
      kind: 'milestoneComplete';
      version: string;
      /** Resolved runtime slash command for the Operator Next Steps hint (e.g. '/gsd:new-milestone'). */
      nextMilestoneCommand: string;
    };
// Phases 6–7 add the remaining intent kinds to this discriminated union.

export type StateTransitionResult = {
  content: string;
  updated: string[];
  /** Intent-specific output (e.g. advancePlan returns {advanced, currentPlan, totalPlans}).
   * Adapters read this to construct the CLI output shape. */
  data?: Record<string, unknown>;
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
export function transitionCore(
  content: string,
  intent: StateTransitionIntent,
  deps: StateTransitionDeps,
): StateTransitionResult {
  switch (intent.kind) {
    case 'beginPhase':
      return beginPhaseCore(content, intent, deps);
    case 'advancePlan':
      return advancePlanCore(content, deps);
    case 'completePhase':
      return completePhaseCore(content, intent, deps);
    case 'plannedPhase':
      return plannedPhaseCore(content, intent, deps);
    case 'milestoneSwitch':
      return milestoneSwitchCore(content, intent, deps);
    case 'milestoneComplete':
      return milestoneCompleteCore(content, intent, deps);
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
function beginPhaseCore(
  content: string,
  intent: { kind: 'beginPhase'; phaseNumber: string | number; phaseName: string | null; planCount: number | null },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];

  // #1255: body-field replacements operate on body only (frontmatter stripped),
  // not on the full content. The YAML `status:` key matches `^Status:\s*`
  // before the body pipe-table row if full content is passed.
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const hasFrontmatter = Object.keys(existingFm).length > 0;
  let body = stripFrontmatter(content);

  const reassemble = (b: string): string =>
    hasFrontmatter
      ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}`
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
      throw new Error(
        `transitionCore beginPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // Helper: try to replace a body field; push to `updated` on success.
  // Body field names (Title Case: 'Status', 'Current Phase') are not in the
  // table — they're body-side aliases of classified frontmatter keys.
  const tryField = (name: string, value: string): void => {
    const replaced = stateReplaceField(body, name, value);
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
  const currentStatus = stateExtractField(body, 'Status') || '';
  const isAlreadyExecuting = new RegExp(
    `Executing Phase\\s+${escapeRegex(String(intent.phaseNumber))}\\b`,
    'i',
  ).test(currentStatus);

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
      body = body.replace(focusPattern, (_match, prefix: string) => `${prefix}${focusLabel}`);
      updated.push('Current focus');
    }

    // ## Current Position section mutation (#1104, #1365).
    // ADR-1372 T6: tokenizeHeadings + offset splicing (replaceSection adoption
    // deferred to a later phase). Mirrors state.cts:2261-2324 byte-for-behaviour.
    body = mutateCurrentPositionFirstTime(body, intent, today, updated);
  } else {
    // Resume path: only update Last activity timestamp in Current Position
    // (do not touch Plan:, Phase:, Status:, stopped_at, progress.percent).
    body = mutateCurrentPositionResume(body, intent, today, updated);
  }

  return { content: reassemble(body), updated };
}

// Local frontmatter type aliases matching frontmatter.cts so we can call
// reconstructFrontmatter without cross-module type re-exports.
type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

/**
 * Find the `## Current Position` section, return its `{start, end}` byte
 * offsets in `body` (end is exclusive — first byte of the next section or
 * body.length). Returns `null` when the section is absent.
 *
 * ADR-1372 T6: tokenizeHeadings-based locator (fence-aware).
 */
function locateCurrentPosition(body: string): { start: number; end: number } | null {
  const hs = tokenizeHeadings(body);
  const idx = hs.findIndex(h => h.level === 2 && /^current\s+position$/i.test(h.text));
  if (idx === -1) return null;
  const h = hs[idx];
  const lines = body.split('\n');
  const hl = lines[h.line - 1];
  const start = h.offset + hl.length + 1;
  let end = body.length;
  for (let j = idx + 1; j < hs.length; j++) {
    if (STOP_H2_PLUS(hs[j].level)) { end = hs[j].offset - 1; break; }
  }
  return { start, end };
}

/**
 * First-time ## Current Position mutation: update Phase / Plan / Status /
 * Last activity lines. Mirrors state.cts:2261-2324 byte-for-behaviour
 * (inline regex first, pipe-table fallback via stateReplaceField — #1257).
 */
function mutateCurrentPositionFirstTime(
  body: string,
  intent: { phaseNumber: string | number; phaseName: string | null; planCount: number | null },
  today: string,
  updated: string[],
): string {
  const span = locateCurrentPosition(body);
  if (span === null) return body;
  let sectionBody = body.slice(span.start, span.end);

  // Phase line — inline first, then pipe-table fallback (#1257).
  const phaseLabel = `${intent.phaseNumber}${intent.phaseName ? ` (${intent.phaseName})` : ''} — EXECUTING`;
  if (/^Phase:/m.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${phaseLabel}`);
  } else {
    const replaced = stateReplaceField(sectionBody, 'Phase', phaseLabel);
    if (replaced !== null) sectionBody = replaced;
  }

  // Plan line.
  const planValue = `1 of ${intent.planCount || '?'}`;
  if (/^Plan:/m.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${planValue}`);
  } else {
    const replaced = stateReplaceField(sectionBody, 'Plan', planValue);
    if (replaced !== null) sectionBody = replaced;
  }

  // Status line.
  const statusValue = `Executing Phase ${intent.phaseNumber}`;
  if (/^Status:/m.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Status:.*$/m, `Status: ${statusValue}`);
  } else {
    const replaced = stateReplaceField(sectionBody, 'Status', statusValue);
    if (replaced !== null) sectionBody = replaced;
  }

  // Last activity line. The inline value carries date + narrative.
  const activityValue = `${today} — Phase ${intent.phaseNumber} execution started`;
  if (/^Last activity:/im.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Last activity:.*$/im, `Last activity: ${activityValue}`);
  } else {
    const replaced =
      stateReplaceField(sectionBody, 'Last Activity', activityValue) ??
      stateReplaceField(sectionBody, 'Last activity', activityValue);
    if (replaced !== null) sectionBody = replaced;
  }

  updated.push('Current Position');
  return body.slice(0, span.start) + sectionBody + body.slice(span.end);
}

/**
 * Resume ## Current Position mutation: only update Last activity line
 * (preserves Plan/Phase/Status — #3127). Mirrors state.cts:2329-2363
 * byte-for-behaviour.
 */
function mutateCurrentPositionResume(
  body: string,
  intent: { phaseNumber: string | number },
  today: string,
  updated: string[],
): string {
  const span = locateCurrentPosition(body);
  if (span === null) return body;
  let sectionBody = body.slice(span.start, span.end);

  const resumeActivity = `Last activity: ${today} — Phase ${intent.phaseNumber} execution resumed (wave continue)`;
  if (/^Last activity:/im.test(sectionBody)) {
    sectionBody = sectionBody.replace(/^Last activity:.*$/im, resumeActivity);
    updated.push('Last activity (resume)');
  } else {
    // Pipe-table format fallback (#1255).
    const replaced =
      stateReplaceField(sectionBody, 'Last Activity', resumeActivity) ??
      stateReplaceField(sectionBody, 'Last activity', resumeActivity);
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
function stripFrontmatter(content: string): string {
  let result = content;
  while (true) {
    const stripped = result.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*/, '');
    if (stripped === result) break;
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
function mutateCurrentPositionForAdvance(
  content: string,
  fields: { status?: string; lastActivity?: string; plan?: string },
  statusDefaults: string[] | null | undefined,
  lastActivityDefaults: string[] | null | undefined,
): string {
  const span = locateCurrentPosition(content);
  if (span === null) return content;
  let sectionBody = content.slice(span.start, span.end);
  let mutated = false;

  if (fields.status) {
    const replaced = stateReplaceFieldIfTemplate(sectionBody, 'Status', statusDefaults, fields.status);
    if (replaced !== null && replaced !== sectionBody) { sectionBody = replaced; mutated = true; }
  }

  if (fields.lastActivity) {
    const replaced =
      stateReplaceFieldIfTemplate(sectionBody, 'Last Activity', lastActivityDefaults, fields.lastActivity) ??
      stateReplaceFieldIfTemplate(sectionBody, 'Last activity', lastActivityDefaults, fields.lastActivity);
    if (replaced !== null && replaced !== sectionBody) { sectionBody = replaced; mutated = true; }
  }

  if (fields.plan) {
    // Plan is always replaced — system-derived, not executor-authored.
    if (/^Plan:/m.test(sectionBody)) {
      sectionBody = sectionBody.replace(/^Plan:.*$/m, `Plan: ${fields.plan}`);
      mutated = true;
    } else {
      const replaced = stateReplaceField(sectionBody, 'Plan', fields.plan);
      if (replaced !== null) { sectionBody = replaced; mutated = true; }
    }
  }

  if (!mutated) return content;
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
function advancePlanCore(content: string, deps: StateTransitionDeps): StateTransitionResult {
  const today = deps.clock.today();

  // #1255: body-field replacements operate on body only (frontmatter stripped),
  // not on the full content. The YAML `status:` key matches `^Status:\s*`
  // before the body field if full content is passed (codex Phase 2 review:
  // HIGH blocking finding — same pattern beginPhaseCore already handles).
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const hasFrontmatter = Object.keys(existingFm).length > 0;
  let body = stripFrontmatter(content);
  const reassemble = (b: string): string =>
    hasFrontmatter
      ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}`
      : b;

  // Parse plan number — legacy first, then compound.
  const legacyPlan = stateExtractField(content, 'Current Plan');
  const legacyTotal = stateExtractField(content, 'Total Plans in Phase');
  const planField = stateExtractField(content, 'Plan');

  let currentPlan: number;
  let totalPlans: number;
  let useCompoundFormat = false;

  if (legacyPlan && legacyTotal) {
    currentPlan = parseInt(legacyPlan, 10);
    totalPlans = parseInt(legacyTotal, 10);
  } else if (planField) {
    currentPlan = parseInt(planField, 10);
    const ofMatch = planField.match(/of\s+(\d+)/);
    totalPlans = ofMatch ? parseInt(ofMatch[1], 10) : NaN;
    useCompoundFormat = true;
  } else {
    currentPlan = NaN;
    totalPlans = NaN;
  }

  if (isNaN(currentPlan) || isNaN(totalPlans)) {
    return { content: reassemble(body), updated: [], data: { error: true } };
  }

  const updated: string[] = [];

  const statusDefaults = KNOWN_TEMPLATE_DEFAULTS['Status'];
  const lastActivityDefaults = KNOWN_TEMPLATE_DEFAULTS['Last Activity'];

  if (currentPlan >= totalPlans) {
    // Phase-complete branch.
    body = stateReplaceFieldIfTemplate(body, 'Status', statusDefaults, 'Phase complete — ready for verification') || body;
    body = stateReplaceFieldIfTemplate(body, 'Last Activity', lastActivityDefaults, today) || body;
    body = stateReplaceFieldIfTemplate(body, 'Last activity', lastActivityDefaults, today) || body;
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
  let planDisplayValue: string;
  if (useCompoundFormat) {
    planDisplayValue = (planField as string).replace(/^\d+/, String(newPlan));
    body = stateReplaceField(body, 'Plan', planDisplayValue) || body;
  } else {
    planDisplayValue = `${newPlan} of ${totalPlans}`;
    body = stateReplaceField(body, 'Current Plan', String(newPlan)) || body;
  }
  body = stateReplaceFieldIfTemplate(body, 'Status', statusDefaults, 'Ready to execute') || body;
  body = stateReplaceFieldIfTemplate(body, 'Last Activity', lastActivityDefaults, today) || body;
  body = stateReplaceFieldIfTemplate(body, 'Last activity', lastActivityDefaults, today) || body;
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
function completePhaseCore(
  content: string,
  intent: {
    kind: 'completePhase';
    phaseNum: string;
    nextPhaseNum: string | null;
    nextPhaseName: string | null;
    isLastPhase: boolean;
    planCount: number;
    summaryCount: number;
  },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];
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
      throw new Error(
        `transitionCore completePhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // #1255: body-field replacements operate on body only (frontmatter stripped),
  // so the YAML `status:` / `current_phase:` keys cannot shadow the body fields.
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const hasFrontmatter = Object.keys(existingFm).length > 0;
  let body = stripFrontmatter(content);
  const reassemble = (b: string): string =>
    hasFrontmatter
      ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}`
      : b;

  // Current Phase — preserve the existing `of <total>` shape and the phase name
  // in parens (mirrors phase.cts:1675-1697 byte-for-behaviour).
  const phaseValue = intent.nextPhaseNum || intent.phaseNum;
  const nextPhaseDisplayName = intent.nextPhaseName;
  const existingPhaseField =
    stateExtractField(body, 'Current Phase') || stateExtractField(body, 'Phase');
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
    } else if (nextPhaseDisplayName) {
      newPhaseValue = `${phaseValue} — ${nextPhaseDisplayName}`;
    }
  }
  const phaseAfter = stateReplaceFieldWithFallback(body, 'Current Phase', 'Phase', newPhaseValue);
  if (phaseAfter !== body) {
    body = phaseAfter;
    updated.push('Current Phase');
  }

  // Current Phase Name — only written when a next-phase display name is known
  // (#1743/#1695: classified curated/preserve-always, so an absent name does
  // NOT clear an existing curated value).
  if (nextPhaseDisplayName) {
    const after = stateReplaceField(body, 'Current Phase Name', nextPhaseDisplayName);
    if (after) {
      body = after;
      updated.push('Current Phase Name');
    }
  }

  // Status — `Milestone complete` on the final phase, otherwise `Ready to plan`.
  const statusValue = intent.isLastPhase ? 'Milestone complete' : 'Ready to plan';
  const statusAfter = stateReplaceFieldWithFallback(body, 'Status', null, statusValue);
  if (statusAfter !== body) {
    body = statusAfter;
    updated.push('Status');
  }

  // Current Plan — reset for the next phase.
  const planAfter = stateReplaceFieldWithFallback(body, 'Current Plan', 'Plan', 'Not started');
  if (planAfter !== body) {
    body = planAfter;
    updated.push('Current Plan');
  }

  // Last Activity — prefer the prose `Last activity:` line (date + narrative)
  // when present, else the bold `Last Activity:` date field.
  const lastActivityDescription = `Phase ${intent.phaseNum} complete${intent.nextPhaseNum ? `, transitioned to Phase ${intent.nextPhaseNum}` : ''}`;
  if (/^Last activity:/m.test(body)) {
    const after = stateReplaceField(body, 'Last activity', `${today} — ${lastActivityDescription}`);
    if (after) {
      body = after;
      updated.push('Last Activity');
    }
  } else {
    const after = stateReplaceField(body, 'Last Activity', today);
    if (after) {
      body = after;
      updated.push('Last Activity');
    }
  }

  const ladAfter = stateReplaceField(body, 'Last Activity Description', lastActivityDescription);
  if (ladAfter) {
    body = ladAfter;
    updated.push('Last Activity Description');
  }

  // Progress block — re-derive completed/total phases from the roadmap when
  // available (milestone-wide source of truth), then recompute the percent.
  // Only runs when a Completed Phases field exists (the existing guard).
  const completedRaw = stateExtractField(body, 'Completed Phases');
  if (completedRaw !== null) {
    let newCompleted = parseInt(completedRaw, 10);
    let derivedTotalPhases: number | null = null;
    const roadmapContent = deps.roadmapProvider ? deps.roadmapProvider() : null;
    if (roadmapContent) {
      const derived = deriveProgressFromRoadmap(roadmapContent);
      if (derived.completedPhases !== null) newCompleted = derived.completedPhases;
      if (derived.totalPhases !== null) derivedTotalPhases = derived.totalPhases;
    }
    const completedAfter = stateReplaceField(body, 'Completed Phases', String(newCompleted));
    if (completedAfter) {
      body = completedAfter;
      updated.push('Completed Phases');
    }

    const totalRaw = stateExtractField(body, 'Total Phases');
    const totalPhases = derivedTotalPhases || (totalRaw ? parseInt(totalRaw, 10) : null);
    if (totalPhases && totalPhases > 0) {
      const newPercent = clampPercent(newCompleted, totalPhases);
      const progAfter = stateReplaceField(body, 'Progress', `${newPercent}%`);
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

// ----------------------------------------------------------------------------
// plannedPhase — intent implementation (Phase 4)
// ----------------------------------------------------------------------------

/**
 * Apply a `plannedPhase` transition to STATE.md content.
 *
 * Migrates `cmdStatePlannedPhase` (state.cts) onto the substrate. Updates the
 * per-phase body fields after plan-phase runs: Status (template-aware — only
 * replaces handler-generated values, preserving executor-authored ones),
 * Total Plans in Phase, Last Activity (template-aware), Last Activity
 * Description, and the ## Current Position section. The adapter wraps this in
 * `readModifyWriteStateMd({ resync: false })` so the milestone-wide progress.*
 * frontmatter is NOT re-derived from a half-planned disk snapshot (#500 RC1).
 *
 * Uses `mutateCurrentPositionForAdvance` (the inlined twin of state.cts's
 * `updateCurrentPositionFields`) so the Knuth template-default invariant
 * applies inside the Current Position section too.
 */
function plannedPhaseCore(
  content: string,
  intent: { kind: 'plannedPhase'; phaseNumber: string | number; planCount: number | null },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];
  const today = deps.clock.today();

  for (const fmKey of ['status', 'last_activity', 'last_activity_desc']) {
    const cls = getFieldClassification(fmKey);
    if (cls === null) {
      throw new Error(
        `transitionCore plannedPhase: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // #1255: body-field replacements operate on body only.
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const hasFrontmatter = Object.keys(existingFm).length > 0;
  let body = stripFrontmatter(content);
  const reassemble = (b: string): string =>
    hasFrontmatter
      ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}`
      : b;

  const statusDefaults = KNOWN_TEMPLATE_DEFAULTS['Status'];
  const lastActivityDefaults = KNOWN_TEMPLATE_DEFAULTS['Last Activity'];

  // Status — template-aware (preserve executor-authored values).
  const statusAfter = stateReplaceFieldIfTemplate(body, 'Status', statusDefaults, 'Ready to execute');
  if (statusAfter !== null && statusAfter !== body) {
    body = statusAfter;
    updated.push('Status');
  }

  // Total Plans in Phase — system-derived; always replaced when a count is given.
  if (intent.planCount !== null && intent.planCount !== undefined) {
    const result = stateReplaceField(body, 'Total Plans in Phase', String(intent.planCount));
    if (result) {
      body = result;
      updated.push('Total Plans in Phase');
    }
  }

  // Last Activity — template-aware.
  const lastActivityAfter = stateReplaceFieldIfTemplate(body, 'Last Activity', lastActivityDefaults, today);
  if (lastActivityAfter !== null && lastActivityAfter !== body) {
    body = lastActivityAfter;
    updated.push('Last Activity');
  }

  // Last Activity Description.
  const ladResult = stateReplaceField(
    body,
    'Last Activity Description',
    `Phase ${intent.phaseNumber} planning complete — ${intent.planCount || '?'} plans ready`,
  );
  if (ladResult) {
    body = ladResult;
    updated.push('Last Activity Description');
  }

  // ## Current Position section — Status + Last activity (template-aware).
  const beforePos = body;
  body = mutateCurrentPositionForAdvance(
    body,
    {
      status: 'Ready to execute',
      lastActivity: `${today} — Phase ${intent.phaseNumber} planning complete`,
    },
    statusDefaults,
    lastActivityDefaults,
  );
  if (body !== beforePos) updated.push('Current Position');

  return { content: reassemble(body), updated };
}

// ----------------------------------------------------------------------------
// milestoneSwitch — intent implementation (Phase 4)
// ----------------------------------------------------------------------------

/**
 * Apply a `milestoneSwitch` transition to STATE.md content.
 *
 * Migrates `cmdStateMilestoneSwitch` (state.cts) onto the substrate. Resets
 * STATE.md for a new milestone cycle: rewrites the frontmatter (milestone,
 * milestone_name, status='planning', last_updated, last_activity, and the
 * progress block zeroed) and rewrites the ## Current Position body to the
 * "defining requirements" starting state. `gsd_state_version` is preserved.
 * Body content OUTSIDE Current Position (e.g. Accumulated Context) is
 * preserved.
 *
 * This is a destructive reset intent: it intentionally overwrites the curated
 * `progress` / `current_phase_name` fields (classified preserve-always) because
 * a new milestone starts from zero. That is the intent's contract, not a
 * violation of the field-classification table — the table governs the steady-
 * state RMW transitions; a milestone boundary is an explicit reset.
 *
 * The adapter wraps this in `acquireStateLock` + `platformWriteSync` (NOT
 * `readModifyWriteStateMd`) because milestoneSwitch rebuilds frontmatter
 * directly and must not run the steady-state `syncStateFrontmatter` post-sync.
 */
function milestoneSwitchCore(
  content: string,
  intent: { kind: 'milestoneSwitch'; version: string; name: string },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const today = deps.clock.today();
  const updated: string[] = [
    'milestone',
    'milestone_name',
    'status',
    'last_updated',
    'last_activity',
    'progress',
    'Current Position',
  ];

  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const body = stripFrontmatter(content);
  const resolvedName = (intent.name && intent.name.trim()) || 'milestone';

  // ## Current Position reset body (mirrors state.cts:2371-2375).
  const resetPositionBody =
    `\nPhase: Not started (defining requirements)\n` +
    `Plan: —\n` +
    `Status: Defining requirements\n` +
    `Last activity: ${today} — Milestone ${intent.version} started\n\n`;

  let newBody: string;
  const hs = tokenizeHeadings(body);
  const posIdx = hs.findIndex((h) => h.level === 2 && /^current\s+position$/i.test(h.text));
  if (posIdx !== -1) {
    const h = hs[posIdx];
    const lines = body.split('\n');
    const hl = lines[h.line - 1];
    const bodyStart = h.offset + hl.length + 1;
    let bodyEnd = body.length;
    for (let j = posIdx + 1; j < hs.length; j++) {
      if (STOP_H2_PLUS(hs[j].level)) {
        bodyEnd = hs[j].offset - 1;
        break;
      }
    }
    newBody = body.slice(0, bodyStart) + resetPositionBody + body.slice(bodyEnd);
  } else {
    const preface = body.trim().length > 0 ? body : '# Project State\n';
    newBody = `${preface.trimEnd()}\n\n## Current Position\n${resetPositionBody}`;
  }

  // Rebuilt frontmatter — curated fields are intentionally reset (milestone
  // boundary). gsd_state_version is preserved.
  const fm: Record<string, unknown> = {
    gsd_state_version: existingFm['gsd_state_version'] || '1.0',
    milestone: intent.version,
    milestone_name: resolvedName,
    status: 'planning',
    last_updated: deps.clock.nowIso(),
    last_activity: today,
    progress: {
      total_phases: 0,
      completed_phases: 0,
      total_plans: 0,
      completed_plans: 0,
      percent: 0,
    },
  };

  const yamlStr = reconstructFrontmatter(fm as unknown as Frontmatter);
  const assembled = `---\n${yamlStr}\n---\n\n${newBody.replace(/^\n+/, '')}`;
  return { content: assembled, updated };
}

// ----------------------------------------------------------------------------
// milestoneComplete — intent implementation (Phase 5)
// ----------------------------------------------------------------------------

/**
 * Apply a `milestoneComplete` transition to STATE.md content.
 *
 * Migrates the STATE.md write path inside `cmdMilestoneComplete` (milestone.cts)
 * onto the substrate. Owns the closure write: Status (`<version> milestone
 * complete`), Last Activity, Last Activity Description, a ## Current Position
 * reset to the "Awaiting next milestone" state, and a ## Operator Next Steps
 * reset pointing at the next-milestone command.
 *
 * The adapter (`cmdMilestoneComplete`) retains `writeStateMd` (the writer that
 * owns the lock + steady-state syncStateFrontmatter post-sync) and resolves the
 * runtime-specific next-milestone slash command, injecting it via
 * `intent.nextMilestoneCommand` so the core stays pure.
 *
 * The two section resets use raw regex (with the pre-seam `allow-adhoc-markdown`
 * waivers carried from milestone.cts) rather than tokenizeHeadings because the
 * `## Operator Next Steps` section is non-canonical (not in STATE_MD_SECTIONS)
 * and the existing behavior + its tests pin the exact regex semantics. A future
 * collectSection migration (#1372) can swap both to section primitives.
 *
 * Behavior is byte-for-byte with the pre-migration milestone.cts:314-353 block.
 */
function milestoneCompleteCore(
  content: string,
  intent: { kind: 'milestoneComplete'; version: string; nextMilestoneCommand: string },
  deps: StateTransitionDeps,
): StateTransitionResult {
  const updated: string[] = [];
  const today = deps.clock.today();
  const version = intent.version;

  for (const fmKey of ['status', 'last_activity', 'last_activity_desc']) {
    const cls = getFieldClassification(fmKey);
    if (cls === null) {
      throw new Error(
        `transitionCore milestoneComplete: frontmatter key ${JSON.stringify(fmKey)} is not in FIELD_CLASSIFICATION; ` +
        `add a row per ADR-1769 §4 before touching it.`,
      );
    }
  }

  // #1255: body-field replacements operate on body only.
  const existingFm = extractFrontmatter(content) as Record<string, unknown>;
  const hasFrontmatter = Object.keys(existingFm).length > 0;
  let body = stripFrontmatter(content);
  const reassemble = (b: string): string =>
    hasFrontmatter
      ? `---\n${reconstructFrontmatter(existingFm as unknown as Frontmatter)}\n---\n\n${b}`
      : b;

  // Status — `<version> milestone complete`.
  const statusAfter = stateReplaceFieldWithFallback(body, 'Status', null, `${version} milestone complete`);
  if (statusAfter !== body) {
    body = statusAfter;
    updated.push('Status');
  }

  // Last Activity.
  const lastActivityAfter = stateReplaceFieldWithFallback(body, 'Last Activity', 'Last activity', today);
  if (lastActivityAfter !== body) {
    body = lastActivityAfter;
    updated.push('Last Activity');
  }

  // Last Activity Description.
  const ladAfter = stateReplaceFieldWithFallback(
    body,
    'Last Activity Description',
    null,
    `${version} milestone completed and archived`,
  );
  if (ladAfter !== body) {
    body = ladAfter;
    updated.push('Last Activity Description');
  }

  // ## Current Position reset — stop resume/progress flows pointing at closed
  // execution instructions.
  const positionPattern = /(##\s*Current Position\s*\n)([\s\S]*?)(?=\n##|$)/i; // allow-adhoc-markdown: pre-seam section write-modify carried from milestone.cts; pending collectSection migration #1372
  const closedPositionBody =
    `\nPhase: Milestone ${version} complete\n` +
    `Plan: —\n` +
    `Status: Awaiting next milestone\n` +
    `Last activity: ${today} — Milestone ${version} completed and archived\n\n`;
  if (positionPattern.test(body)) {
    body = body.replace(positionPattern, (_m, header: string) => `${header}${closedPositionBody}`);
  } else {
    body = `${body.trimEnd()}\n\n## Current Position\n${closedPositionBody}`;
  }
  updated.push('Current Position');

  // ## Operator Next Steps — normalize stale tails that can persist after close.
  const operatorPattern = /(##\s*Operator Next Steps\s*\n)([\s\S]*?)(?=\n##|$)/i; // allow-adhoc-markdown: pre-seam section write-modify carried from milestone.cts; pending collectSection migration #1372
  if (operatorPattern.test(body)) {
    body = body.replace(
      operatorPattern,
      `$1\n- Start the next milestone with ${intent.nextMilestoneCommand}\n\n`,
    );
  } else {
    body = `${body.trimEnd()}\n\n## Operator Next Steps\n\n- Start the next milestone with ${intent.nextMilestoneCommand}\n`;
  }
  updated.push('Operator Next Steps');

  return { content: reassemble(body), updated };
}
