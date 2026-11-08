/**
 * Criterion Replay Module (#4310, ADR-4310).
 *
 * Re-runs the command behind each judged `[HEAD=<v> EXPECT<op><v>]` notation
 * and compares the printed value with the recorded HEAD value. Pure; the
 * runner, clock and HEAD sha are injected, so this module does no I/O.
 */

import {
  scanBaselineNotation,
  compareBaseline,
  renderBaselineValue,
  decodeNotationEntities,
  type BaselineValue,
  type BaselineScanResult,
} from './criterion-baseline.cjs';

export const REPLAY_STATUS = Object.freeze({
  NO_COMMAND: 'no_command',
  AMBIGUOUS_COMMAND: 'ambiguous_command',
  MALFORMED_COMMAND: 'malformed_command',
  DISALLOWED: 'disallowed',
  CANNOT_RUN: 'cannot_run',
  TIMEOUT: 'timeout',
  OUTPUT_CAP: 'output_cap',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  TRUNCATED: 'truncated',
  REPLAY_ERROR: 'replay_error',
} as const);

export const REPLAY_LIMITS = Object.freeze({
  MAX_COMMANDS: 50,
  PER_COMMAND_TIMEOUT_MS: 10000,
  TOTAL_BUDGET_MS: 60000,
  OUTPUT_CAP_BYTES: 65536,
  MAX_COMMAND_LENGTH: 1000,
  MAX_TOKENS: 64,
} as const);

/** Most statuses a replay records; the rest collapse into the one `truncated` entry. */
export const MAX_REPLAY_STATUSES = 50;

export type ReplayStatusCode = (typeof REPLAY_STATUS)[keyof typeof REPLAY_STATUS];

type Failure = { status: ReplayStatusCode; detail: string };

const ZONE_TAG_PREFIX = /^\s*(?:<(?:verify|automated|acceptance_criteria)>\s*)*/;

export function extractCriterionCommand(lineText: string, column: number): { command: string } | Failure {
  const prefix = lineText.slice(0, column);
  const spans = prefix.match(/`([^`\r\n]*)`/g) ?? [];
  let cmd: string;
  if (spans.length > 1) {
    return { status: REPLAY_STATUS.AMBIGUOUS_COMMAND, detail: 'more than one backtick span precedes the notation' };
  }
  if (spans.length === 1) {
    cmd = spans[0].slice(1, -1).trim();
  } else {
    const trimmed = prefix.replace(/[ \t]+$/, '');
    if (!trimmed.endsWith('#')) {
      return { status: REPLAY_STATUS.NO_COMMAND, detail: 'no backtick span or trailing comment names a command' };
    }
    cmd = trimmed.slice(0, -1).replace(ZONE_TAG_PREFIX, '').trim();
  }
  if (cmd.length === 0) return { status: REPLAY_STATUS.NO_COMMAND, detail: 'the command is empty' };
  return { command: decodeNotationEntities(cmd) };
}

const UNQUOTED_META = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', '{', '}', '~']);

/** A recognizer for plain words and quotes, not a shell: anything a shell would interpret is refused. */
export function tokenizeCriterionCommand(command: string): { argv: string[] } | Failure {
  if (command.length > REPLAY_LIMITS.MAX_COMMAND_LENGTH) {
    return { status: REPLAY_STATUS.DISALLOWED, detail: `command longer than ${REPLAY_LIMITS.MAX_COMMAND_LENGTH} characters` };
  }
  if (/[\r\n\u0000]/.test(command)) {
    return { status: REPLAY_STATUS.DISALLOWED, detail: 'command contains a line break or NUL' };
  }
  const argv: string[] = [];
  let cur: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === ' ' || ch === '\t') {
      if (cur !== null) argv.push(cur);
      cur = null;
      i += 1;
    } else if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return { status: REPLAY_STATUS.MALFORMED_COMMAND, detail: 'unterminated single quote' };
      cur = (cur ?? '') + command.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let buf = '';
      let closed = false;
      while (j < command.length) {
        const c = command[j];
        if (c === '"') { closed = true; break; }
        if (c === '$' || c === '`') {
          return { status: REPLAY_STATUS.DISALLOWED, detail: 'expansion inside double quotes' };
        }
        if (c === '\\' && j + 1 < command.length) {
          const next = command[j + 1];
          buf += next === '"' || next === '\\' || next === '$' || next === '`' ? next : `\\${next}`;
          j += 2;
          continue;
        }
        buf += c;
        j += 1;
      }
      if (!closed) return { status: REPLAY_STATUS.MALFORMED_COMMAND, detail: 'unterminated double quote' };
      cur = (cur ?? '') + buf;
      i = j + 1;
    } else if (ch === '\\') {
      if (i + 1 >= command.length) return { status: REPLAY_STATUS.MALFORMED_COMMAND, detail: 'trailing backslash' };
      cur = (cur ?? '') + command[i + 1];
      i += 2;
    } else if (ch === '#' && cur === null) {
      return { status: REPLAY_STATUS.DISALLOWED, detail: 'shell comment' };
    } else if (UNQUOTED_META.has(ch)) {
      return { status: REPLAY_STATUS.DISALLOWED, detail: `unquoted shell metacharacter ${ch}` };
    } else {
      cur = (cur ?? '') + ch;
      i += 1;
    }
  }
  if (cur !== null) argv.push(cur);
  if (argv.length === 0) return { status: REPLAY_STATUS.NO_COMMAND, detail: 'the command has no words' };
  if (argv.length > REPLAY_LIMITS.MAX_TOKENS) {
    return { status: REPLAY_STATUS.DISALLOWED, detail: `more than ${REPLAY_LIMITS.MAX_TOKENS} tokens` };
  }
  return { argv };
}

const ALLOWED_PROGRAMS = new Set(['grep', 'git']);
const ALLOWED_GIT_SUBCOMMANDS = new Set(['grep', 'ls-files', 'rev-parse', 'rev-list']);
interface OptionSpec {
  /** Single-character boolean flags, accepted alone or clustered. */
  short: ReadonlySet<string>;
  /** Long options that take no value, matched exactly (an abbreviation is not on the list). */
  long: ReadonlySet<string>;
  /** Long options that take a value; the value must follow '=' in the same token. */
  valued: ReadonlySet<string>;
  /** The one exact short token whose next token is its value (a pattern or a count). */
  valueShort: string | null;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(' ').filter((w) => w.length > 0));
const chars = (s: string): ReadonlySet<string> => new Set(s);

const GREP_SPEC: OptionSpec = {
  short: chars('civwxFEGnlLqsrhHoyI'),
  long: words(
    '--count --ignore-case --invert-match --word-regexp --line-regexp --fixed-strings --extended-regexp --basic-regexp --quiet --silent --no-messages --recursive --no-filename --with-filename --files-with-matches --files-without-match --only-matching --line-number',
  ),
  valued: words('--regexp --include --exclude --exclude-dir'),
  valueShort: '-e',
};

const GIT_SPECS: Readonly<Record<string, OptionSpec>> = Object.freeze({
  grep: {
    short: chars('civwnlLhHFEGPIoq'),
    long: words(
      '--count --ignore-case --invert-match --word-regexp --line-number --files-with-matches --name-only --files-without-match --fixed-strings --extended-regexp --basic-regexp --perl-regexp --quiet --cached --untracked --no-index --full-name --and --or --not --all-match',
    ),
    valued: words(''),
    valueShort: '-e',
  },
  'ls-files': {
    short: words('c o d m'),
    long: words('--cached --others --deleted --modified --exclude-standard --full-name'),
    valued: words(''),
    valueShort: null,
  },
  'rev-parse': {
    short: words('q'),
    long: words('--verify --quiet --is-inside-work-tree --show-toplevel --abbrev-ref --show-prefix --short'),
    valued: words('--short'),
    valueShort: null,
  },
  'rev-list': {
    short: words(''),
    long: words('--count --all --no-merges --merges --first-parent'),
    valued: words('--max-count'),
    valueShort: '-n',
  },
});

function isOutsideRoot(candidate: string): boolean {
  return /^[\\/]/.test(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.split(/[\\/]/).includes('..');
}

export interface QuarantineOptions {
  /** Injected so this module stays pure: false when the operand resolves outside the project. */
  isInsideRoot?: (operand: string) => boolean;
}

/** Exact-match option allowlist: an option not named here (including any abbreviation of one) is refused. */
export function checkReplayQuarantine(argv: string[], opts: QuarantineOptions = {}): null | { status: 'disallowed'; detail: string } {
  const program = argv[0];
  if (typeof program !== 'string' || !ALLOWED_PROGRAMS.has(program)) {
    return { status: 'disallowed', detail: 'program is not on the allowlist (grep, git)' };
  }
  let spec: OptionSpec;
  let tokens: string[];
  if (program === 'git') {
    if (argv.length < 2 || !ALLOWED_GIT_SUBCOMMANDS.has(argv[1])) {
      return { status: 'disallowed', detail: 'git subcommand is not on the allowlist' };
    }
    spec = GIT_SPECS[argv[1]];
    tokens = argv.slice(2);
  } else {
    spec = GREP_SPEC;
    tokens = argv.slice(1);
  }
  const disallowed = (detail: string): { status: 'disallowed'; detail: string } => ({ status: 'disallowed', detail });
  const pathProblem = (candidate: string): boolean => {
    if (isOutsideRoot(candidate)) return true;
    return opts.isInsideRoot !== undefined && !opts.isInsideRoot(candidate);
  };
  let operandsOnly = false;
  let takesValueNext = false;
  for (const token of tokens) {
    if (takesValueNext) {
      takesValueNext = false;
      if (pathProblem(token)) return disallowed('path_outside_root');
      continue;
    }
    if (operandsOnly || !token.startsWith('-') || token === '-') {
      if (pathProblem(token)) return disallowed('path_outside_root');
      continue;
    }
    if (token === '--') {
      operandsOnly = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const value = eq === -1 ? undefined : token.slice(eq + 1);
      if (spec.valued.has(name)) {
        if (value === undefined) {
          if (!spec.long.has(name)) return disallowed('option ' + name + ' needs =value');
        } else if (pathProblem(value)) {
          return disallowed('path_outside_root');
        }
      } else if (spec.long.has(name)) {
        if (value !== undefined) return disallowed('option ' + name + ' takes no value');
      } else {
        return disallowed('option ' + name + ' is not allowed');
      }
      continue;
    }
    if (spec.valueShort !== null && token === spec.valueShort) {
      takesValueNext = true;
      continue;
    }
    for (const ch of token.slice(1)) {
      if (!spec.short.has(ch)) return disallowed('option ' + token + ' is not allowed');
    }
  }
  if (takesValueNext) return disallowed('malformed: option is missing its value');
  return null;
}

export function deriveObservedValue(r: { outcome: string; exitCode: number | null; stdout?: string }): { value: BaselineValue } | Failure {
  if (r.outcome === 'timed_out') return { status: REPLAY_STATUS.TIMEOUT, detail: 'the command timed out' };
  if (r.outcome === 'overflow') return { status: REPLAY_STATUS.OUTPUT_CAP, detail: 'the command printed more than the output cap' };
  if (r.outcome !== 'exited') return { status: REPLAY_STATUS.CANNOT_RUN, detail: `the command did not exit (${String(r.outcome)})` };
  const code = r.exitCode;
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) {
    return { status: REPLAY_STATUS.CANNOT_RUN, detail: 'the exit code is not in 0..255' };
  }
  if (code >= 2) return { value: { kind: 'error', code } };
  const s = String(r.stdout ?? '').trim();
  if (/^-?\d{1,15}$/.test(s)) return { value: { kind: 'integer', value: Number(s) } };
  return { value: code === 0 ? { kind: 'present' } : { kind: 'absent' } };
}

export interface ReplayRunner {
  (argv: string[], opts: { timeoutMs: number }): { outcome: string; exitCode: number | null; stdout?: string };
}
export interface ReplayDeps {
  run: ReplayRunner;
  now: () => number;
  headSha: string | null;
  scan?: (c: string) => BaselineScanResult;
  isInsideRoot?: (p: string) => boolean;
}
export interface ReplayResult {
  line: number;
  text: string;
  argv: string[];
  recorded: BaselineValue;
  observed: BaselineValue;
  outcome: 'match' | 'mismatch';
  rev_drift: boolean;
}
export interface ReplayStatus {
  code: ReplayStatusCode;
  line: number;
  text: string;
  detail: string;
}
export interface ReplayReport {
  head_sha: string | null;
  results: ReplayResult[];
  mismatch_count: number;
  statuses: ReplayStatus[];
  warnings: string[];
}

function lineBounds(content: string, index: number): { start: number; end: number } {
  const start = Math.max(content.lastIndexOf('\n', index - 1), content.lastIndexOf('\r', index - 1)) + 1;
  const nl = content.indexOf('\n', index);
  const cr = content.indexOf('\r', index);
  const ends = [nl, cr].filter((n) => n !== -1);
  return { start, end: ends.length > 0 ? Math.min(...ends) : content.length };
}

export function replayBaselineCriteria(content: unknown, deps: ReplayDeps): ReplayReport {
  const headSha = deps.headSha ?? null;
  const report: ReplayReport = { head_sha: headSha, results: [], mismatch_count: 0, statuses: [], warnings: [] };
  try {
    if (typeof content !== 'string' || content.length === 0) return report;
    const records = (deps.scan ?? scanBaselineNotation)(content).notations;
    const start = deps.now();
    let ran = 0;
    let skipped = 0;
    let dropped = 0;
    const addStatus = (code: ReplayStatusCode, line: number, text: string, detail: string): void => {
      if (report.statuses.length >= MAX_REPLAY_STATUSES) { dropped += 1; return; }
      report.statuses.push({ code, line, text, detail });
    };
    for (const record of records) {
      const { start: lineStart, end: lineEnd } = lineBounds(content, record.index);
      const lineText = content.slice(lineStart, lineEnd);
      const extracted = extractCriterionCommand(lineText, record.index - lineStart);
      if ('status' in extracted) { addStatus(extracted.status, record.line, record.text, extracted.detail); continue; }
      const tokens = tokenizeCriterionCommand(extracted.command);
      if ('status' in tokens) { addStatus(tokens.status, record.line, record.text, tokens.detail); continue; }
      const refused = checkReplayQuarantine(tokens.argv, { isInsideRoot: deps.isInsideRoot });
      if (refused !== null) { addStatus(refused.status, record.line, record.text, refused.detail); continue; }
      if (ran >= REPLAY_LIMITS.MAX_COMMANDS) { skipped += 1; continue; }
      const elapsed = deps.now() - start;
      if (elapsed >= REPLAY_LIMITS.TOTAL_BUDGET_MS) {
        addStatus(REPLAY_STATUS.BUDGET_EXHAUSTED, record.line, record.text, 'the total replay time budget is spent');
        continue;
      }
      const timeoutMs = Math.min(REPLAY_LIMITS.PER_COMMAND_TIMEOUT_MS, REPLAY_LIMITS.TOTAL_BUDGET_MS - elapsed);
      ran += 1;
      let raw: { outcome: string; exitCode: number | null; stdout?: string };
      try {
        raw = deps.run(tokens.argv, { timeoutMs });
      } catch (e) {
        addStatus(REPLAY_STATUS.CANNOT_RUN, record.line, record.text, e instanceof Error ? e.message : String(e));
        continue;
      }
      const derived = deriveObservedValue(raw);
      if ('status' in derived) { addStatus(derived.status, record.line, record.text, derived.detail); continue; }
      const observed = derived.value;
      const recorded = record.notation.head;
      const matched = compareBaseline(recorded, '==', observed) === true;
      const revDrift = record.notation.rev !== null && typeof deps.headSha === 'string' && !deps.headSha.startsWith(record.notation.rev);
      report.results.push({
        line: record.line,
        text: record.text,
        argv: tokens.argv,
        recorded,
        observed,
        outcome: matched ? 'match' : 'mismatch',
        rev_drift: revDrift,
      });
      if (!matched) {
        report.mismatch_count += 1;
        report.warnings.push(
          `[plan-criteria replay] line ${record.line}: recorded HEAD=${renderBaselineValue(recorded)}, the command printed ${renderBaselineValue(observed)}${revDrift ? ' (baseline pinned to another commit)' : ''}`,
        );
      }
    }
    if (skipped > 0 || dropped > 0) {
      report.statuses.push({
        code: REPLAY_STATUS.TRUNCATED,
        line: 0,
        text: '',
        detail: `${skipped} command(s) not replayed after the first ${REPLAY_LIMITS.MAX_COMMANDS}; ${dropped} further status(es) omitted`,
      });
    }
    return report;
  } catch (e) {
    return {
      head_sha: headSha,
      results: [],
      mismatch_count: 0,
      statuses: [{ code: REPLAY_STATUS.REPLAY_ERROR, line: 0, text: '', detail: e instanceof Error ? e.message : String(e) }],
      warnings: [],
    };
  }
}
