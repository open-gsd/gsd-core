/**
 * Criterion Baseline Module (#4309).
 *
 * A closed annotation grammar written next to a quantitative criterion:
 *
 *   [HEAD=<value> EXPECT<op><value> [@<sha>] [GUARD MUTATION: <ref>] [UNPINNED]]
 *   value ∈ <integer> | absent | present | error:<exit-code>
 *   op    ∈ ==  !=  >=  >  <=  <
 *
 * The notation records what the criterion measures at HEAD, so a criterion that
 * already holds before the change (and therefore proves nothing) is caught
 * statically: rule B1. A free-form `# baseline at HEAD:` comment is the legacy
 * form this notation replaces: rule B2 (warning).
 *
 * Pure: no fs, no child_process, no console. Nothing is executed (replay is a
 * separate concern). Every parse failure becomes a status, never an exit code
 * change (fail open). Every regex is bounded: the closing-bracket search is a
 * slice of at most 500 characters that stops at a line break.
 */

import { extractTaggedBlockSpans } from './markdown-sectionizer.cjs';

export const BASELINE_RULE = Object.freeze({
  NON_DISCRIMINATING: 'B1',
  LEGACY_COMMENT: 'B2',
} as const);

export const BASELINE_STATUS = Object.freeze({
  MALFORMED: 'malformed',
  BAD_VALUE: 'bad_value',
  ORDERING_NEEDS_INTEGER: 'ordering_needs_integer',
  BAD_REV: 'bad_rev',
  PIN_CONFLICT: 'pin_conflict',
  UNRECOGNIZED_TRAILING: 'unrecognized_trailing',
  UNTERMINATED: 'unterminated',
  OUTSIDE_CRITERIA_ZONE: 'outside_criteria_zone',
  SCANNER_ERROR: 'scanner_error',
  TRUNCATED: 'truncated',
} as const);

/** Most statuses a scan records; the rest collapse into one `truncated` entry. */
export const MAX_BASELINE_STATUSES = 50;

export type BaselineRuleId = (typeof BASELINE_RULE)[keyof typeof BASELINE_RULE];
export type BaselineStatusCode = (typeof BASELINE_STATUS)[keyof typeof BASELINE_STATUS];

export type BaselineValue =
  | { kind: 'integer'; value: number }
  | { kind: 'absent' }
  | { kind: 'present' }
  | { kind: 'error'; code: number };

export type BaselineOp = '==' | '!=' | '>=' | '>' | '<=' | '<';

export interface BaselineNotation {
  head: BaselineValue;
  op: BaselineOp;
  expect: BaselineValue;
  rev: string | null;
  guard: boolean;
  mutation: string | null;
  unpinned: boolean;
}

export interface BaselineFinding {
  rule: BaselineRuleId;
  severity: 'error' | 'warning';
  line: number;
  text: string;
  message: string;
}

export interface BaselineStatus {
  code: BaselineStatusCode;
  line: number;
  text: string;
  detail: string;
}

export interface BaselineParseResult {
  notation: BaselineNotation | null;
  statuses: { code: BaselineStatusCode; detail: string }[];
}

export interface BaselineNotationRecord {
  line: number;
  index: number;
  text: string;
  notation: BaselineNotation;
}

export interface BaselineScanResult {
  findings: BaselineFinding[];
  statuses: BaselineStatus[];
  notationCount: number;
  notations: BaselineNotationRecord[];
  errors: string[];
  warnings: string[];
}

const CLOSE_SEARCH_WINDOW = 500;
const TEXT_CAP = 200;
const ZONE_TAGS = ['acceptance_criteria', 'automated', 'verify'] as const;

const INTEGER_RE = /^-?\d{1,15}$/;
const ERROR_RE = /^error:(\d{1,3})$/;
const REV_RE = /^[0-9a-f]{7,40}$/;
const HEAD_EXPECT_RE = /^\s*HEAD\s*=\s*(\S+)\s+EXPECT\s*(==|!=|>=|<=|>|<)\s*(\S+?)(?=\s|$)/;
const OPENER_RE = /\[[ \t]*HEAD[ \t]*=/g;
const LEGACY_RE = /#[ \t]*baseline[ \t]+at[ \t]+HEAD[ \t]*:/gi;
const ALLOW_RE = /<!--\s*plan-criteria-allow:\s*(R[1-6]|B[12])\s+-\s+([^>\n]{0,500}?\S)\s*-->/g;

/** Parse one value token; null when it is outside the value grammar. */
export function parseBaselineValue(token: string): BaselineValue | null {
  if (typeof token !== 'string') return null;
  if (INTEGER_RE.test(token)) return { kind: 'integer', value: Number(token) };
  if (token === 'absent') return { kind: 'absent' };
  if (token === 'present') return { kind: 'present' };
  const err = ERROR_RE.exec(token);
  if (err) {
    const code = Number(err[1]);
    if (code >= 1 && code <= 255) return { kind: 'error', code };
  }
  return null;
}

/** Inverse of `parseBaselineValue`. */
export function renderBaselineValue(v: BaselineValue): string {
  switch (v.kind) {
    case 'integer': return String(v.value);
    case 'error': return `error:${v.code}`;
    case 'absent': return 'absent';
    default: return 'present';
  }
}

function valuesEqual(a: BaselineValue, b: BaselineValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'integer' && b.kind === 'integer') return a.value === b.value;
  if (a.kind === 'error' && b.kind === 'error') return a.code === b.code;
  return true;
}

/**
 * Does `head op expect` already hold? null when the operator needs an integer
 * EXPECT and got none. A non-integer HEAD never satisfies an ordering operator.
 */
export function compareBaseline(head: BaselineValue, op: BaselineOp, expect: BaselineValue): boolean | null {
  if (op === '==') return valuesEqual(head, expect);
  if (op === '!=') return !valuesEqual(head, expect);
  if (expect.kind !== 'integer') return null;
  if (head.kind !== 'integer') return false;
  switch (op) {
    case '>=': return head.value >= expect.value;
    case '>': return head.value > expect.value;
    case '<=': return head.value <= expect.value;
    default: return head.value < expect.value;
  }
}

export function decodeNotationEntities(s: string): string {
  return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** Parse the text between `[` and `]`. Fatal problems yield a null notation. */
export function parseBaselineNotation(inner: string): BaselineParseResult {
  const statuses: { code: BaselineStatusCode; detail: string }[] = [];
  const fatal = (code: BaselineStatusCode, detail: string): BaselineParseResult => ({
    notation: null,
    statuses: [{ code, detail }],
  });

  const text = decodeNotationEntities(String(inner));
  const m = HEAD_EXPECT_RE.exec(text);
  if (!m) return fatal(BASELINE_STATUS.MALFORMED, 'expected `HEAD=<value> EXPECT<op><value>` with op one of == != >= > <= <');
  const op = m[2] as BaselineOp;
  const headToken = m[1];
  const expectToken = m[3];
  if (expectToken.startsWith('=')) {
    return fatal(BASELINE_STATUS.MALFORMED, `unknown operator near \`${op}${expectToken}\``);
  }
  const head = parseBaselineValue(headToken);
  const expect = parseBaselineValue(expectToken);
  if (head === null || expect === null) {
    const bad = head === null ? headToken : expectToken;
    return fatal(BASELINE_STATUS.BAD_VALUE, `\`${bad.slice(0, 60)}\` is not an integer, absent, present or error:<1-255>`);
  }
  if (op !== '==' && op !== '!=' && expect.kind !== 'integer') {
    return fatal(BASELINE_STATUS.ORDERING_NEEDS_INTEGER, `operator \`${op}\` needs an integer EXPECT`);
  }

  let tail = text.slice(m[0].length).trim();
  let rev: string | null = null;
  let guard = false;
  let mutation: string | null = null;
  let unpinned = false;

  const revMatch = /^@(\S*)/.exec(tail);
  if (revMatch) {
    tail = tail.slice(revMatch[0].length).trim();
    if (REV_RE.test(revMatch[1])) {
      rev = revMatch[1];
    } else {
      statuses.push({ code: BASELINE_STATUS.BAD_REV, detail: `\`@${revMatch[1].slice(0, 60)}\` is not a 7-40 character lowercase hex sha` });
    }
  }
  const guardMatch = /^GUARD(?=\s|$)/.exec(tail);
  if (guardMatch) {
    guard = true;
    tail = tail.slice(guardMatch[0].length).trim();
    const mutMatch = /^MUTATION:([\s\S]*)$/.exec(tail);
    if (mutMatch) {
      let ref = mutMatch[1].trim();
      const trailingUnpinned = /(?:^|\s)UNPINNED$/.exec(ref);
      if (trailingUnpinned) {
        unpinned = true;
        ref = ref.slice(0, ref.length - trailingUnpinned[0].length).trim();
      }
      const misplacedPin = /(?:^|\s)(@\S+)$/.exec(ref);
      if (misplacedPin) {
        statuses.push({
          code: BASELINE_STATUS.UNRECOGNIZED_TRAILING,
          detail: `\`${misplacedPin[1].slice(0, 60)}\` must precede GUARD (\`@<rev> GUARD MUTATION: <ref>\`)`,
        });
        ref = ref.slice(0, ref.length - misplacedPin[0].length).trim();
      }
      mutation = ref.length > 0 ? ref : null;
      tail = '';
    }
  }
  const unpinnedMatch = /^UNPINNED(?=\s|$)/.exec(tail);
  if (unpinnedMatch) {
    unpinned = true;
    tail = tail.slice(unpinnedMatch[0].length).trim();
  }
  if (tail.length > 0) {
    statuses.push({ code: BASELINE_STATUS.UNRECOGNIZED_TRAILING, detail: `unrecognized text after the notation: \`${tail.slice(0, 60)}\`` });
  }
  if (rev !== null && unpinned) {
    statuses.push({ code: BASELINE_STATUS.PIN_CONFLICT, detail: '`@<sha>` and `UNPINNED` are mutually exclusive' });
  }

  return { notation: { head, op, expect, rev, guard, mutation, unpinned }, statuses };
}

/**
 * Rule ids carried by `<!-- plan-criteria-allow: <id> - <reason> -->` markers.
 * The reason must be non-empty. Shared with the #4024 R-rule scanner.
 */
export function parseCriteriaAllowMarkers(content: string): Set<string> {
  const allow = new Set<string>();
  if (typeof content !== 'string') return allow;
  const re = new RegExp(ALLOW_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) allow.add(m[1]);
  return allow;
}

function emptyResult(): BaselineScanResult {
  return { findings: [], statuses: [], notationCount: 0, notations: [], errors: [], warnings: [] };
}

function cap(s: string): string {
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}...` : s;
}

function describeB1(n: BaselineNotation): string {
  const cmp = `${renderBaselineValue(n.head)} ${n.op} ${renderBaselineValue(n.expect)}`;
  const base = `criterion already holds at HEAD (${cmp}), so it measures nothing about this change; `
    + 'tighten the criterion so it fails at HEAD, or record `GUARD MUTATION: <ref>`';
  return n.guard && n.mutation === null
    ? `${base} (GUARD is present but its MUTATION reference is missing or empty)`
    : base;
}

/** Scan a plan for baseline notations (B1) and legacy baseline comments (B2). */
export function scanBaselineNotation(
  content: unknown,
  deps: { parseNotation?: typeof parseBaselineNotation } = {},
): BaselineScanResult {
  if (typeof content !== 'string' || content.length === 0) return emptyResult();
  try {
    const parse = deps.parseNotation ?? parseBaselineNotation;
    const result = emptyResult();
    const allow = parseCriteriaAllowMarkers(content);

    const spans: { start: number; end: number }[] = [];
    for (const tag of ZONE_TAGS) spans.push(...extractTaggedBlockSpans(content, tag));
    const inZone = (idx: number): boolean => spans.some((s) => idx >= s.start && idx < s.end);

    let cursorIdx = 0;
    let cursorLine = 1;
    const lineAt = (idx: number): number => {
      if (idx < cursorIdx) {
        cursorIdx = 0;
        cursorLine = 1;
      }
      for (let i = cursorIdx; i < idx; i += 1) {
        const c = content.charCodeAt(i);
        // A bare CR ends a line; the CR of a CRLF pair is counted by its LF.
        if (c === 10 || (c === 13 && content.charCodeAt(i + 1) !== 10)) cursorLine += 1;
      }
      cursorIdx = idx;
      return cursorLine;
    };

    let droppedStatuses = 0;
    let firstDroppedLine = 0;
    let firstDroppedText = '';
    const addStatus = (code: BaselineStatusCode, line: number, text: string, detail: string): void => {
      if (result.statuses.length >= MAX_BASELINE_STATUSES) {
        if (droppedStatuses === 0) {
          firstDroppedLine = line;
          firstDroppedText = text;
        }
        droppedStatuses += 1;
        return;
      }
      result.statuses.push({ code, line, text: cap(text), detail });
    };
    const addFinding = (rule: BaselineRuleId, line: number, text: string, message: string): void => {
      if (allow.has(rule)) return;
      const severity = rule === 'B1' ? 'error' : 'warning';
      result.findings.push({ rule, severity, line, text: cap(text), message });
      const rendered = `[plan-criteria ${rule}] line ${line}: ${message}`;
      (severity === 'error' ? result.errors : result.warnings).push(rendered);
    };

    const opener = new RegExp(OPENER_RE.source, 'g');
    let om: RegExpExecArray | null;
    while ((om = opener.exec(content)) !== null) {
      const idx = om.index;
      const line = lineAt(idx);
      const windowEnd = Math.min(content.length, idx + 1 + CLOSE_SEARCH_WINDOW);
      let close = -1;
      for (let i = idx + 1; i < windowEnd; i += 1) {
        const c = content.charCodeAt(i);
        if (c === 93) { close = i; break; }
        if (c === 10 || c === 13) break;
      }
      if (close === -1) {
        addStatus(BASELINE_STATUS.UNTERMINATED, line, content.slice(idx, Math.min(windowEnd, idx + TEXT_CAP)), 'no closing `]` on the same line');
        continue;
      }
      result.notationCount += 1;
      const text = content.slice(idx, close + 1);
      if (!inZone(idx)) {
        addStatus(BASELINE_STATUS.OUTSIDE_CRITERIA_ZONE, line, text, 'notation is not inside <acceptance_criteria>, <automated> or <verify>; not judged');
        continue;
      }
      let parsed: BaselineParseResult;
      try {
        parsed = parse(content.slice(idx + 1, close));
      } catch (e) {
        addStatus(BASELINE_STATUS.SCANNER_ERROR, line, text, e instanceof Error ? e.message : String(e));
        continue;
      }
      for (const s of parsed.statuses) addStatus(s.code, line, text, s.detail);
      const n = parsed.notation;
      if (n === null) continue;
      result.notations.push({ line, index: idx, text: cap(text), notation: n });
      const holds = compareBaseline(n.head, n.op, n.expect);
      if (holds === true && !(n.guard && n.mutation !== null)) {
        addFinding(BASELINE_RULE.NON_DISCRIMINATING, line, text, describeB1(n));
      }
    }

    const legacy = new RegExp(LEGACY_RE.source, 'gi');
    let lm: RegExpExecArray | null;
    while ((lm = legacy.exec(content)) !== null) {
      if (!inZone(lm.index)) continue;
      addFinding(
        BASELINE_RULE.LEGACY_COMMENT,
        lineAt(lm.index),
        lm[0],
        'free-form `# baseline at HEAD:` comment is not checked; write `[HEAD=<value> EXPECT<op><value>]` instead',
      );
    }
    if (droppedStatuses > 0) {
      result.statuses.push({
        code: BASELINE_STATUS.TRUNCATED,
        line: firstDroppedLine,
        text: cap(firstDroppedText),
        detail: `${droppedStatuses} further status${droppedStatuses === 1 ? '' : 'es'} omitted after the first ${MAX_BASELINE_STATUSES}`,
      });
    }
    return result;
  } catch (e) {
    const failed = emptyResult();
    failed.statuses.push({
      code: BASELINE_STATUS.SCANNER_ERROR,
      line: 0,
      text: '',
      detail: e instanceof Error ? e.message : String(e),
    });
    return failed;
  }
}
