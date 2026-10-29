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
 *   entry  := indent marker mgap box gap bold? gap <caller tail>
 *   indent := [ \t]*                   — an entry starts its line
 *   marker := '-' | '*'
 *   mgap   := [ \t]{1,4}               — a list item: `-[ ]` is not one (#5764)
 *   box    := '[' (' ' | 'x' | 'X') ']'
 *   bold   := '**' | '__'              — a reader may require it
 *   gap    := [ \t]*                   — horizontal whitespace only
 * A reader that needs plain `- **Phase N**` bullets may make the box optional.
 *
 * Writers (flip, delete, renumber, id rewrite) compose their patterns here too
 * (#5764, Phase 4): `phaseEntryRegExp` for a whole-line match and
 * `phaseEntrySplitRegExp` when the writer rewrites the box and needs the text on
 * either side of it.
 */

export interface PhaseEntryPrefixOptions {
  /** `required`: the bold token must be present; `optional` (default): it may be. */
  bold?: 'required' | 'optional';
  /** `required` (default): a `[ ]`/`[x]` box; `optional`: plain `- **Phase N**` bullets too. */
  box?: 'required' | 'optional';
  /**
   * Which box states match: `any` (default), `unchecked` (`[ ]` only),
   * `checked` (`[x]`/`[X]` only) or `captured` (any state, as capture group 1 —
   * the box character).
   */
  state?: 'any' | 'unchecked' | 'checked' | 'captured';
  /**
   * Allow any text between the box and the label (`- [x] ~~**Phase 4: X**~~`, an emoji, a
   * tag) instead of an optional bold token. Only for a writer that must keep numbering
   * consistent over entries the readers skip, such as `phase remove`'s renumber; it still
   * needs the box, so a mention in the middle of a sentence is never an entry. Overrides `bold`
   * and `box`.
   */
  decorated?: boolean;
}

const MARKER_SRC = '[-*]';
// A list item has 1 to 4 spaces or tabs after its marker (CommonMark: none is not a list item,
// five or more makes the rest an indented code block), so `-[ ] **Phase 1**` is not an entry.
const MARKER_GAP_SRC = '[ \\t]{1,4}';
const BOLD_TOKEN_SRC = '(?:\\*\\*|__)';

/** Regex source of one bold token, for a reader that must also consume the closing wrapper. */
export const PHASE_ENTRY_BOLD_TOKEN_SRC = BOLD_TOKEN_SRC;

/**
 * Regex source of a closing bold wrapper for a reader that captures the entry's
 * name up to it. `**` closes anywhere; `__` closes only at the end of the line,
 * so a name that contains `__init__` or `__tests__` is not cut short.
 */
export const PHASE_ENTRY_BOLD_CLOSE_SRC = '(?:\\*\\*|__(?=[ \\t]*\\r?$))';

/**
 * Line start, indent, marker and the marker's gap, up to where the box opens.
 * A leading BOM can only precede the first line; it is not part of the grammar's indent.
 */
const LINE_OPEN_SRC = `^\\uFEFF?[ \\t]*${MARKER_SRC}${MARKER_GAP_SRC}`;

/**
 * Source for the bold token and its trailing gap. `(?:token[ \t]*)?` rather than
 * `[ \t]*` + token + `[ \t]*`, which backtracks quadratically on a long blank run.
 */
function boldSrcFor(bold: PhaseEntryPrefixOptions['bold']): string {
  return bold === 'required' ? `${BOLD_TOKEN_SRC}[ \\t]*` : `(?:${BOLD_TOKEN_SRC}[ \\t]*)?`;
}

/** Source for the box interior, honouring the requested state filter. */
function stateSrc(state: PhaseEntryPrefixOptions['state']): string {
  if (state === 'unchecked') return ' ';
  if (state === 'checked') return '[xX]';
  if (state === 'captured') return '([ xX])';
  return '[ xX]';
}

/**
 * Regex source of everything before the caller's `Phase`/label tail: line start, indent,
 * marker, box, bold token and the horizontal gaps between them. A `captured`
 * state adds exactly one capture group (the box character) at the front.
 */
export function phaseEntryPrefixSrc(options: PhaseEntryPrefixOptions = {}): string {
  const { bold = 'optional', box = 'required', state = 'any', decorated = false } = options;
  // The decoration may not contain the word `Phase`, so the entry's own label is the first one
  // on the line and `- [ ] **Phase 5**: needs Phase 2` is not an entry of phase 2. No gap
  // before the run: `[ \t]*` then a lazy run overlap and backtrack quadratically.
  if (decorated) return `${LINE_OPEN_SRC}\\[${stateSrc(state)}\\](?:(?!Phase)[^\\r\\n])*?`;
  const boxSrc = `\\[${stateSrc(state)}\\][ \\t]*`;
  const body = box === 'optional' ? `(?:${boxSrc})?` : boxSrc;
  return `${LINE_OPEN_SRC}${body}${boldSrcFor(bold)}`;
}

/**
 * A RegExp for a phase entry: the grammar prefix followed by the caller's
 * `tailSrc`. The `m` flag is always set, so `^` is a line start.
 */
export function phaseEntryRegExp(tailSrc: string, flags = '', options: PhaseEntryPrefixOptions = {}): RegExp {
  const withM = flags.includes('m') ? flags : `${flags}m`;
  return new RegExp(`${phaseEntryPrefixSrc(options)}${tailSrc}`, withM);
}

/**
 * A RegExp for a phase entry a writer rewrites at the box: capture group 1 is
 * everything through the opening `[` (indent, marker, gap) and capture group 2
 * is everything from the closing `]` through the end of `tailSrc` (gap, bold
 * token, label). A flip is `line.replace(re, '$1x$2')`; the box state itself is
 * matched, not captured, so the writer chooses the new state. The `m` flag is
 * always set.
 */
export function phaseEntrySplitRegExp(
  tailSrc: string,
  flags = '',
  options: Pick<PhaseEntryPrefixOptions, 'bold'> & { state?: 'any' | 'unchecked' | 'checked' } = {},
): RegExp {
  const { bold = 'optional', state = 'any' } = options;
  const withM = flags.includes('m') ? flags : `${flags}m`;
  return new RegExp(`(${LINE_OPEN_SRC}\\[)${stateSrc(state)}(\\][ \\t]*${boldSrcFor(bold)}${tailSrc})`, withM);
}

const ENTRY_BOX_RE = new RegExp(`^\\uFEFF?[ \\t]*${MARKER_SRC}${MARKER_GAP_SRC}\\[([ xX])\\]`);

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
