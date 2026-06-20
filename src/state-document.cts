/**
 * STATE.md Document Module — pure transforms for STATE.md text.
 * This module does not read the filesystem and does not own persistence or locking.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/state-document.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

// Internal helpers
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

interface ProgressRecord {
  total_phases?: unknown;
  completed_phases?: unknown;
  total_plans?: unknown;
  completed_plans?: unknown;
  percent?: unknown;
  [key: string]: unknown;
}

function existingProgressExceedsDerived(existingProgress: ProgressRecord, derivedProgress: ProgressRecord, key: string): boolean {
  const existing = toFiniteNumber(existingProgress[key]);
  const derived = toFiniteNumber(derivedProgress[key]);
  return existing !== null && derived !== null && existing > derived;
}

/**
 * Return true if a pipe-table row's first cell is a separator cell (`---`
 * variants) rather than a field name.  Prevents the separator row
 * `| --- | --- |` from being treated as a field named "---".
 */
function isTableSeparatorRow(firstCell: string): boolean {
  // A separator cell contains only dashes, colons (alignment hints), and whitespace.
  return /^[\s\-:]+$/.test(firstCell.trim());
}

/**
 * Build a regex that matches a pipe-table row `| FieldName | value |` for the
 * given (already-escaped) field name.  The match is case-insensitive and
 * tolerates variable amounts of whitespace around the cell contents.
 *
 * Capture group 1: leading pipe + whitespace before the field cell
 * Capture group 2: the field name cell text (trimmed)
 * Capture group 3: whitespace between field cell and separator pipe
 * Capture group 4: the value cell text (trimmed)
 * Capture group 5: trailing whitespace + closing pipe(s)
 *
 * We use a single-line match (`m` flag so ^ anchors work on each line) to
 * avoid cross-row replacement.
 */
function tableRowPattern(escapedFieldName: string): RegExp {
  return new RegExp(
    `^(\\|[ \\t]*)(${escapedFieldName})([ \\t]*\\|[ \\t]*)([^|\\n]*?)([ \\t]*\\|[ \\t]*)$`,
    'im',
  );
}

export function stateExtractField(content: string, fieldName: string): string | null {
  const escaped = escapeRegex(fieldName);
  // Bold inline format: **FieldName:** value
  const boldPattern = new RegExp(`\\*\\*${escaped}:\\*\\*[ \\t]*(.+)`, 'i');
  const boldMatch = content.match(boldPattern);
  if (boldMatch)
    return boldMatch[1].trim();
  // Plain line-start format: FieldName: value
  const plainPattern = new RegExp(`^${escaped}:[ \\t]*(.+)`, 'im');
  const plainMatch = content.match(plainPattern);
  if (plainMatch)
    return plainMatch[1].trim();
  // Pipe-table format: | FieldName | value |
  // (Separator rows such as `| --- | --- |` are excluded.)
  const tableMatch = content.match(tableRowPattern(escaped));
  if (tableMatch && !isTableSeparatorRow(tableMatch[2]))
    return tableMatch[4].trim();
  return null;
}

export function stateReplaceField(content: string, fieldName: string, newValue: string): string | null {
  const escaped = escapeRegex(fieldName);
  // Bold inline format: **FieldName:** value
  const boldPattern = new RegExp(`(\\*\\*${escaped}:\\*\\*\\s*)(.*)`, 'i');
  if (boldPattern.test(content)) {
    return content.replace(boldPattern, (_match, prefix: string) => `${prefix}${newValue}`);
  }
  // Plain line-start format: FieldName: value
  const plainPattern = new RegExp(`(^${escaped}:\\s*)(.*)`, 'im');
  if (plainPattern.test(content)) {
    return content.replace(plainPattern, (_match, prefix: string) => `${prefix}${newValue}`);
  }
  // Pipe-table format: | FieldName | value |
  // Preserve the surrounding pipe/whitespace structure; only swap the value cell.
  const tblPat = tableRowPattern(escaped);
  const tblMatch = content.match(tblPat);
  if (tblMatch && !isTableSeparatorRow(tblMatch[2])) {
    // Reconstruct the row, preserving the original surrounding whitespace/pipes.
    return content.replace(tblPat, (_m, leadPipe: string, fieldCell: string, midPipe: string, _oldVal: string, trailPipe: string) =>
      `${leadPipe}${fieldCell}${midPipe}${newValue}${trailPipe}`,
    );
  }
  return null;
}

export function stateReplaceFieldWithFallback(content: string, primary: string, fallback: string | null | undefined, value: string): string {
  let result = stateReplaceField(content, primary, value);
  if (result)
    return result;
  if (fallback) {
    result = stateReplaceField(content, fallback, value);
    if (result)
      return result;
  }
  return content;
}

export function normalizeStateStatus(status: string | null | undefined, pausedAt: unknown): string {
  let normalizedStatus = status || 'unknown';
  const statusLower = (status || '').toLowerCase();
  if (statusLower.includes('paused') || statusLower.includes('stopped') || pausedAt) {
    normalizedStatus = 'paused';
  }
  else if (statusLower.includes('executing') || statusLower.includes('in progress')) {
    normalizedStatus = 'executing';
  }
  else if (statusLower.includes('planning') || statusLower.includes('ready to plan')) {
    normalizedStatus = 'planning';
  }
  else if (statusLower.includes('discussing')) {
    normalizedStatus = 'discussing';
  }
  else if (statusLower.includes('verif')) {
    normalizedStatus = 'verifying';
  }
  else if (statusLower.includes('complete') || statusLower.includes('done')) {
    normalizedStatus = 'completed';
  }
  else if (statusLower.includes('ready to execute')) {
    normalizedStatus = 'executing';
  }
  return normalizedStatus;
}

export function computeProgressPercent(
  completedPlans: number | null,
  totalPlans: number | null,
  completedPhases: number | null,
  totalPhases: number | null
): number | null {
  const hasPlanData = totalPlans !== null && totalPlans > 0 && completedPlans !== null;
  const hasPhaseData = totalPhases !== null && totalPhases > 0 && completedPhases !== null;
  if (!hasPlanData && !hasPhaseData)
    return null;
  // Use nullish coalescing to avoid non-null assertion operators (flow narrowing
  // cannot track through intermediate boolean variables).
  const planFraction = hasPlanData ? (completedPlans ?? 0) / (totalPlans ?? 1) : 1;
  const phaseFraction = hasPhaseData ? (completedPhases ?? 0) / (totalPhases ?? 1) : 1;
  return Math.min(100, Math.round(Math.min(planFraction, phaseFraction) * 100));
}

export function shouldPreserveExistingProgress(existingProgress: unknown, derivedProgress: unknown): boolean {
  if (!existingProgress || typeof existingProgress !== 'object')
    return false;
  if (!derivedProgress || typeof derivedProgress !== 'object')
    return false;
  const existing = existingProgress as ProgressRecord;
  const derived = derivedProgress as ProgressRecord;
  // total_phases is intentionally excluded from the ratchet: it must always
  // take the freshly derived value so it can correct downward (#1446).
  // Only completed_phases, total_plans, and completed_plans keep ratchet behaviour.
  return (existingProgressExceedsDerived(existing, derived, 'completed_phases') ||
    existingProgressExceedsDerived(existing, derived, 'total_plans') ||
    existingProgressExceedsDerived(existing, derived, 'completed_plans'));
}

export function normalizeProgressNumbers(progress: unknown): unknown {
  if (!progress || typeof progress !== 'object')
    return progress;
  const normalized: ProgressRecord = { ...(progress as ProgressRecord) };
  for (const key of ['total_phases', 'completed_phases', 'total_plans', 'completed_plans', 'percent']) {
    const number = toFiniteNumber(normalized[key]);
    if (number !== null)
      normalized[key] = number;
  }
  return normalized;
}

/**
 * KNOWN_TEMPLATE_DEFAULTS — per-field table of string values that were written
 * by a GSD handler (not by an executor / human).  A value that appears in this
 * list is safe to overwrite on the next handler call.  Any other value was
 * authored by the executor and must be preserved (Knuth invariant:
 * handler-owns-transition-between-known-template-defaults).
 *
 * Keys must match the canonical field name as it appears in STATE.md.
 * Comparison is case-insensitive so "None" and "none" both match.
 *
 * For Status, exact strings are supplemented by a pattern list
 * (KNOWN_STATUS_PATTERNS) that matches handler-generated values whose exact
 * text is variable (e.g. "Executing Phase 5").
 */
export const KNOWN_TEMPLATE_DEFAULTS: Record<string, string[]> = {
  'Resume File': ['None'],
  'Status': [
    'Ready to execute',
    'Phase complete — ready for verification',
    'Ready to plan',
    'Defining requirements',
    'Planning complete',
    // Legacy / abbreviated handler values present in older STATE.md files
    'Executing',
    'In progress',
    'Planning',
    'Verifying',
    'Completed',
    'Done',
    'Active',
    'Paused',
    'unknown',
  ],
  // Last Activity is a date field; ISO date-only strings (YYYY-MM-DD) are the
  // handler-generated form.  We detect them by shape rather than an exhaustive
  // list because the date changes every day.
  // NOTE: entries here are matched by isStateTemplateDefault using the date regex
  // in addition to exact string equality.
  'Last Activity': [],
  'Last activity': [],
};

/**
 * Regex patterns that match handler-generated Status values whose text includes
 * a variable component (e.g. phase number).  Checked after the KNOWN_TEMPLATE_DEFAULTS
 * exact-match list in isStateTemplateDefault.
 */
export const KNOWN_STATUS_PATTERNS: RegExp[] = [
  /^Executing Phase\s+\d+/i,
  /^Planning Phase\s+\d+/i,
  /^Phase\s+\d+\s+complete/i,
  /^Verifying Phase\s+\d+/i,
  /^Phase complete/i,
  // #1070: LLM executors (e.g. OpenCode) may write "Complete ✓" or bare "Complete"
  // when finishing a phase.  Only bare terminal markers yield to the next phase's
  // "Ready to execute" during planned-phase.  The pattern is anchored at both ends
  // so that statuses with trailing prose (e.g. "Complete but needs manual QA",
  // "Complete — ready for verification") are NOT matched and are preserved as
  // executor-authored values.  Only exact forms like "Complete", "Complete ✓",
  // "Complete✓", or "Complete ☑ " (trailing whitespace) match.
  /^Complete\s*[✓✔✅☑]?\s*$/i,
];

/**
 * Returns true when the given value is a known template default for the field,
 * meaning a GSD handler wrote it and a subsequent handler may replace it.
 *
 * A value is considered a template default when:
 *   (a) it appears in KNOWN_TEMPLATE_DEFAULTS[field] (exact, case-insensitive), OR
 *   (b) it matches the ISO date-only shape (YYYY-MM-DD) for Last Activity fields
 *       (handlers always write bare dates; executors write narrative prose).
 *
 * @param field  - Canonical field name (case-sensitive key lookup attempted
 *                  first, then case-insensitive fallback).
 * @param value  - The current value extracted from STATE.md.
 * @returns boolean
 */
export function isStateTemplateDefault(field: string, value: unknown): boolean {
  if (value === null || value === undefined) return true; // absent → initial write
  // Narrow to string: callers pass string values extracted from STATE.md.
  const v = (typeof value === 'string' ? value : `${value as boolean | number}`).trim();
  if (v === '') return true; // blank → treat as absent

  // Look up the defaults list, trying exact key first then case-insensitive.
  let defaults: string[] | null | undefined = KNOWN_TEMPLATE_DEFAULTS[field];
  if (!defaults) {
    const fieldLower = field.toLowerCase();
    const matchKey = Object.keys(KNOWN_TEMPLATE_DEFAULTS).find(k => k.toLowerCase() === fieldLower);
    defaults = matchKey ? KNOWN_TEMPLATE_DEFAULTS[matchKey] : null;
  }

  if (defaults && defaults.some(d => d.toLowerCase() === v.toLowerCase())) {
    return true;
  }

  const fieldLower = field.toLowerCase();

  // Status: also check pattern list for variable handler-generated values
  // (e.g. "Executing Phase 5", "Planning Phase 3").
  if (fieldLower === 'status') {
    if (KNOWN_STATUS_PATTERNS.some(p => p.test(v))) return true;
  }

  // Last Activity / Last activity: bare ISO date (YYYY-MM-DD) is handler-generated.
  if (fieldLower === 'last activity') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
  }

  return false;
}

/**
 * Replaces a field in STATE.md content only when the existing value is a known
 * template default (or the field is absent).  If the existing value is
 * executor-authored, the content is returned unchanged.
 *
 * When `newValue` is null or undefined the function is a no-op (returns content).
 *
 * @param content       - Full STATE.md text.
 * @param field         - Field name as it appears in STATE.md.
 * @param knownDefaults - The defaults list to check against (typically
 *                         KNOWN_TEMPLATE_DEFAULTS[field]).
 * @param newValue      - Value to write when replacement is permitted.
 * @returns Updated content (or original if skipped).
 */
export function stateReplaceFieldIfTemplate(content: string, field: string, knownDefaults: string[] | null | undefined, newValue: string | null | undefined): string {
  if (newValue === null || newValue === undefined) return content;
  const existing = stateExtractField(content, field);
  // Inline check: absent/blank → always write; in list → write; else → skip.
  if (existing === null || existing === undefined || existing.trim() === '') {
    return stateReplaceField(content, field, newValue) || content;
  }
  const v = existing.trim();
  const inList = (knownDefaults || []).some(d => d.toLowerCase() === v.toLowerCase());
  const fieldLower = field.toLowerCase();
  // Special-case: Status pattern list for variable handler-generated values.
  const matchesStatusPattern = (fieldLower === 'status') && KNOWN_STATUS_PATTERNS.some(p => p.test(v));
  // Special-case: Last Activity bare ISO date (YYYY-MM-DD) is handler-generated.
  const isDateShape = (fieldLower === 'last activity') && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (inList || matchesStatusPattern || isDateShape) {
    return stateReplaceField(content, field, newValue) || content;
  }
  // Executor-authored — preserve.
  return content;
}
