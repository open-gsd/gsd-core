/**
 * Phase-entry grammar — the one definition of a ROADMAP phase-list entry
 * (`- [ ] **Phase 1: Name**`): bullet marker, checkbox, bold token and line
 * anchoring (#5763, Phase 3 of epic #5692; census in #5703).
 *
 * Before this module every reader owned a private pattern, and the patterns
 * disagreed on each axis (`-` only vs `[-*]`; required, optional or `\*{0,2}`
 * bold; `[ x]` vs `[ xX]` vs `(x| )`; `^`-anchored vs the unanchored forms
 * behind #4965 and #5545). Readers now compose their pattern from the prefix
 * built here and keep only their own tail (label, id token, separator).
 *
 * The accepted grammar:
 *   entry  := indent marker gap box gap bold? gap <caller tail>
 *   indent := [ \t]*                   — an entry starts its line
 *   marker := '-' | '*'
 *   box    := '[' (' ' | 'x' | 'X') ']'
 *   bold   := '**' | '__'              — a reader may require it
 *   gap    := [ \t]*                   — horizontal whitespace only
 * A reader that needs plain `- **Phase N**` bullets may make the box optional.
 *
 * Writers (splice, flip, delete, renumber) are Phase 4 (#5764) and are not
 * migrated here.
 */

export interface PhaseEntryPrefixOptions {
  /** `required`: the bold token must be present; `optional` (default): it may be. */
  bold?: 'required' | 'optional';
  /** `required` (default): a `[ ]`/`[x]` box; `optional`: plain `- **Phase N**` bullets too. */
  box?: 'required' | 'optional';
  /**
   * Which box states match: `any` (default), `unchecked` (`[ ]` only) or
   * `captured` (any state, as capture group 1 — the box character).
   */
  state?: 'any' | 'unchecked' | 'captured';
}

const MARKER_SRC = '[-*]';
const BOLD_TOKEN_SRC = '(?:\\*\\*|__)';

/** Regex source of one bold token, for a reader that must also consume the closing wrapper. */
export const PHASE_ENTRY_BOLD_TOKEN_SRC = BOLD_TOKEN_SRC;

/**
 * Regex source of a closing bold wrapper for a reader that captures the entry's
 * name up to it. `**` closes anywhere; `__` closes only at the end of the line,
 * so a name that contains `__init__` or `__tests__` is not cut short.
 */
export const PHASE_ENTRY_BOLD_CLOSE_SRC = '(?:\\*\\*|__(?=[ \\t]*\\r?$))';

/** Source for the box interior, honouring the requested state filter. */
function stateSrc(state: PhaseEntryPrefixOptions['state']): string {
  if (state === 'unchecked') return ' ';
  if (state === 'captured') return '([ xX])';
  return '[ xX]';
}

/**
 * Regex source of everything before the caller's `Phase`/label tail: line start, indent,
 * marker, box, bold token and the horizontal gaps between them. A `captured`
 * state adds exactly one capture group (the box character) at the front.
 */
export function phaseEntryPrefixSrc(options: PhaseEntryPrefixOptions = {}): string {
  const { bold = 'optional', box = 'required', state = 'any' } = options;
  const boxSrc = `\\[${stateSrc(state)}\\][ \\t]*`;
  // `(?:token[ \t]*)?` rather than `[ \t]*` + token + `[ \t]*`, which backtracks
  // quadratically on a long blank run.
  const boldSrc = bold === 'required' ? `${BOLD_TOKEN_SRC}[ \\t]*` : `(?:${BOLD_TOKEN_SRC}[ \\t]*)?`;
  const body = box === 'optional' ? `(?:${boxSrc})?` : boxSrc;
  // A leading BOM can only precede the first line; it is not part of the grammar's indent.
  return `^\\uFEFF?[ \\t]*${MARKER_SRC}[ \\t]*${body}${boldSrc}`;
}

/**
 * A RegExp for a phase entry: the grammar prefix followed by the caller's
 * `tailSrc`. The `m` flag is always set, so `^` is a line start.
 */
export function phaseEntryRegExp(tailSrc: string, flags = '', options: PhaseEntryPrefixOptions = {}): RegExp {
  const withM = flags.includes('m') ? flags : `${flags}m`;
  return new RegExp(`${phaseEntryPrefixSrc(options)}${tailSrc}`, withM);
}

const ENTRY_BOX_RE = new RegExp(`^\\uFEFF?[ \\t]*${MARKER_SRC}[ \\t]*\\[([ xX])\\]`);

/**
 * Whether a phase entry line (or a regex match of one, which starts at the
 * line) is ticked. The single place the box character is interpreted.
 */
export function isPhaseEntryChecked(entryText: string): boolean {
  const m = ENTRY_BOX_RE.exec(entryText);
  return m !== null && m[1].toLowerCase() === 'x';
}

/** Whether a captured box character (`captured` state option) is a tick. */
export function isBoxCharChecked(boxChar: string): boolean {
  return boxChar.toLowerCase() === 'x';
}
