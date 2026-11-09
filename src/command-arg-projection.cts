/**
 * Command Argument Projection Module (ADR-457 build-at-publish: the
 * hand-written bin/lib/command-arg-projection.cjs collapsed to a TypeScript
 * source of truth).
 *
 * ADR-3473 §8.4 ("failure is a value"): `parseNamedArgs` is now strict and
 * returns a `Result` instead of silently accepting unrecognized or stray
 * positional tokens. See .gsd/phase/feat-3884-failure-is-a-value/40-design.md
 * for the full behavior table (A1-A18) and negative-space section (N1-N8).
 *
 * Shared helpers for command-family adapters to project argv tokens into
 * typed named values and multi-word segments.
 * `requiredFlags` (ADR-4909 D1, #6087) turns a missing value-flag into InvalidArgs.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
const { ERROR_REASON, formatDiagnosticToken } = io;

// Structurally identical to io.cts's own (unexported) ErrorReasonValue type —
// both are computed from the SAME ERROR_REASON object, so the two never
// drift. Needed here (rather than a plain `string`) so `parseNamedArgsOrExit`
// can accept a real ERROR_REASON-typed callback (e.g. io.cts's `error`)
// directly: a `fail` parameter typed with a bare `string` second argument
// fails TypeScript's contravariant function-parameter check against a
// callback whose real signature narrows that argument to ErrorReasonValue.
type ErrorReasonValue = (typeof ERROR_REASON)[keyof typeof ERROR_REASON];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NamedArgSpec {
  valueFlags?: string[];
  /**
   * A required value flag (ADR-4909 D1, #6087). Members must be a subset of
   * `valueFlags`; a missing, empty, or flag-shaped value is an InvalidArgs
   * result. Declare a flag required only when its handler already fails
   * without it (Hyrum's Law).
   */
  requiredFlags?: string[];
  booleanFlags?: string[];
  /**
   * Optional-value flags (added for `--wave`, ADR-3473 Bucket-A correction —
   * `--wave` was misclassified as Bucket C and is in fact a documented,
   * shipped, user-facing form: commands/gsd/execute-phase.md:4,48 and
   * gsd-core/workflows/execute-phase.md:84 extract the value from
   * `$ARGUMENTS` and forward it to the workflow, not to this CLI seam).
   * #2932 (commands/gsd/execute-phase.md:53) records the flag's semantics as
   * token-PRESENCE: `--wave N` is active only if the literal `--wave` token
   * is present. This CLI layer therefore only needs to know the flag was
   * *seen* — the value belongs to the workflow, not to `data`.
   *
   * EXTRACTION: resolves to `true`/`false` exactly like a `booleanFlags`
   * entry — presence only. The #2932 guarantee that `parseNamedArgs`
   * materializes `false` and never leaks `undefined` for an absent flag
   * holds for this kind too.
   * VALIDATION: when the token is `--<name>` for an optional-value flag, the
   * cursor advances by 2 if a next token exists and is NOT flag-shaped
   * (consuming the value so it isn't reported as a stray positional),
   * otherwise by 1.
   * The value is intentionally NOT surfaced in `data` — callers that need it
   * read raw argv themselves (see `execute-phase`'s `args[2]` positional and
   * the shell-side `WAVE_PARAM` reconstruction cited above). This is a
   * single-purpose escape hatch for `--wave`-shaped flags only; it is not a
   * general "value flags are actually optional" mode.
   */
  optionalValueFlags?: string[];
  /**
   * `--name=value` is also accepted (ADR-4909 D1 seam-kinds table). Subset of
   * `valueFlags`. `--name=` counts as present without a value (`null`). Reader:
   * resolve-execution, loop render-hooks, effort sync, update-context,
   * context-predicates, project-instruction-file, record-dispatch-isolation.
   */
  eqFlags?: string[];
  /**
   * Present without a value (no next token, a flag-shaped next token, or
   * `--name=`) is InvalidArgs `Missing value for --name`; an absent flag stays
   * `null`. Subset of `valueFlags`. Reader: resolve-execution, loop
   * render-hooks, milestone `--release-map` and the eq-form readers.
   */
  nonEmptyFlags?: string[];
  /**
   * A bare `--name` yields `''` instead of `null`, so presence is read from
   * `data`. Subset of `valueFlags`. Reader: stamp-codebase-map `--files`.
   */
  bareEmptyFlags?: string[];
  /**
   * `data[name]` is a `string[]` of every occurrence's value, in order; an
   * occurrence with no value (absent or flag-shaped next token, or `--name=`)
   * contributes nothing. Subset of `valueFlags`. Reader: prompt-budget
   * `--plan-file`, restore-custom-files `--config-dir` (last wins).
   */
  repeatableFlags?: string[];
  /**
   * Each occurrence starts a run collecting non-`--` tokens up to the next
   * list flag of this spec (`--` tokens inside a run are skipped by extraction
   * but still validated); repeated runs merge. `data[name]` is a `string[]`.
   * Independent kind: disjoint from every other kind. This is gsd-tools.cjs
   * `collectListFlagValues`. Reader: commit `--files`/`--files-removed`,
   * commit-to-subrepo `--files`.
   */
  listFlags?: string[];
  /**
   * Collects tokens after the first `--name` up to the next `--`-prefixed
   * token, joined with spaces, or `null` (the `parseMultiwordArg` semantics).
   * Independent kind: disjoint from every other kind. Reader: milestone
   * complete `--name`, scaffold `--name`.
   */
  multiwordFlags?: string[];
  /**
   * Tokens after the first literal `--` are not validated and are returned in
   * `data['--']` (always `[]` when no `--` is present). Reader: review-lane
   * explicit-from-argv. Flag extraction ignores those tokens.
   */
  passthroughAfter?: '--';
  /**
   * Count of leading argv slots the CALLER owns and reads itself (args[0] =
   * family, args[1] = subcommand, plus any documented positional).
   * Validation begins at this index. 'rest' means the caller consumes all
   * remaining tokens as free text; undeclared-flag rejection is disabled
   * entirely for that call (documented exemption, e.g. `init quick`).
   */
  positionals: number | 'rest';
  /**
   * Order-free or variadic positional words past the boundary (commit message
   * words, package names) are accepted instead of reported as stray
   * positionals; flag-shaped tokens are still validated, so an undeclared flag
   * is still rejected. Requires a numeric `positionals`. Extraction is
   * unchanged: the words are not added to `data`. Reader: resolve-execution,
   * pr-subrepo.
   */
  freePositionals?: true;
  /**
   * A token matching `/^-[A-Za-z]/` past the positional boundary is a flag
   * token; short flags are never declared, so it is an unknown flag. `-1` and
   * `-` stay ordinary tokens. For verbs where an accepted-but-ignored short
   * flag would turn a preview into a mutation (todo complete, config-new-project).
   */
  rejectShortFlags?: true;
  /**
   * Template for the unknown-flag InvalidArgs `reason`; `{flag}` is replaced by
   * the raw token and the "accepted:" list is omitted. Keeps a verb's shipped
   * wording (`Unknown flag for todo complete: {flag}`) inside the seam.
   */
  unknownFlagMessage?: string;
}

export type ParsedNamedArgs = Record<string, string | boolean | null | string[]>;

/** Parsed shape when the spec declares no array-valued kind (listFlags, repeatableFlags, passthroughAfter). */
export type ScalarNamedArgs = Record<string, string | boolean | null>;

/** A NamedArgSpec that cannot yield array values; selects the `ScalarNamedArgs` overload. */
export type ScalarNamedArgSpec = Omit<NamedArgSpec, 'repeatableFlags' | 'listFlags' | 'passthroughAfter'> & {
  repeatableFlags?: undefined;
  listFlags?: undefined;
  passthroughAfter?: undefined;
};

export type NamedArgsResult<D = ParsedNamedArgs> =
  | { ok: true; data: D }
  | { ok: false; kind: 'InvalidArgs'; arg: string; reason: string; exitReason: ErrorReasonValue };

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * ADR-3473 Decision 2: both ends of this seam are gsd-core's own source, so a
 * malformed spec (a stale call site still using the legacy
 * `parseNamedArgs(args, valueFlags, booleanFlags)` shape, or a missing spec
 * entirely) is an internal invariant violation, not user input — it throws
 * loudly instead of destructuring `undefined` off a Result.
 */
function assertValidSpec(spec: unknown): asserts spec is NamedArgSpec {
  if (!isPlainObject(spec)) {
    throw new TypeError(
      'parseNamedArgs: spec must be an object of shape ' +
        '{ valueFlags?: string[], booleanFlags?: string[], positionals: number | "rest" }. ' +
        'Received a missing, array, or non-object value — this is the legacy ' +
        'parseNamedArgs(args, valueFlags, booleanFlags) call shape, retired by ADR-3473 §8.4.',
    );
  }
  const positionals = spec.positionals;
  const positionalsValid =
    positionals === 'rest' ||
    (typeof positionals === 'number' && Number.isInteger(positionals) && positionals >= 0);
  if (!positionalsValid) {
    throw new TypeError(
      'parseNamedArgs: spec.positionals must be a non-negative integer or the literal "rest" ' +
        `— received ${JSON.stringify(positionals)}.`,
    );
  }
  if (spec.freePositionals !== undefined && (spec.freePositionals !== true || positionals === 'rest')) {
    throw new TypeError(
      'parseNamedArgs: spec.freePositionals must be true and cannot be combined with positionals "rest" ' +
        `— received freePositionals ${JSON.stringify(spec.freePositionals)} with positionals ${JSON.stringify(positionals)}.`,
    );
  }
  if (spec.rejectShortFlags !== undefined && spec.rejectShortFlags !== true) {
    throw new TypeError(
      `parseNamedArgs: spec.rejectShortFlags must be true — received ${JSON.stringify(spec.rejectShortFlags)}.`,
    );
  }
  if (
    spec.unknownFlagMessage !== undefined &&
    (typeof spec.unknownFlagMessage !== 'string' || !spec.unknownFlagMessage.includes('{flag}'))
  ) {
    throw new TypeError(
      `parseNamedArgs: spec.unknownFlagMessage must be a string containing the {flag} placeholder — received ${JSON.stringify(spec.unknownFlagMessage)}.`,
    );
  }
  for (const kind of VALUE_SUBSET_KINDS) assertSubsetOfValueFlags(spec, kind);
  for (const kind of INDEPENDENT_KINDS) assertIndependentKind(spec, kind);
  if (spec.passthroughAfter !== undefined && spec.passthroughAfter !== '--') {
    throw new TypeError(
      `parseNamedArgs: spec.passthroughAfter must be the literal "--" — received ${JSON.stringify(spec.passthroughAfter)}.`,
    );
  }
}

const VALUE_SUBSET_KINDS = [
  'requiredFlags',
  'eqFlags',
  'nonEmptyFlags',
  'bareEmptyFlags',
  'repeatableFlags',
] as const;

// Kinds that own their tokens: a flag may not also be a plain value, boolean or
// optional flag, nor belong to the other independent kind.
const INDEPENDENT_KINDS = ['listFlags', 'multiwordFlags'] as const;

function assertStringArray(spec: Record<string, unknown>, kind: string): string[] | null {
  const list = spec[kind];
  if (list === undefined) return null;
  if (!Array.isArray(list) || !list.every((f) => typeof f === 'string')) {
    throw new TypeError(`parseNamedArgs: spec.${kind} must be an array of strings.`);
  }
  return list;
}

function assertSubsetOfValueFlags(spec: Record<string, unknown>, kind: string): void {
  const list = assertStringArray(spec, kind);
  if (list === null) return;
  const declared = Array.isArray(spec.valueFlags) ? spec.valueFlags : [];
  const stray = list.filter((f) => !declared.includes(f));
  if (stray.length > 0) {
    throw new TypeError(
      `parseNamedArgs: spec.${kind} must be a subset of spec.valueFlags — ` +
        `not declared as value flags: ${stray.join(', ')}`,
    );
  }
}

function assertIndependentKind(spec: Record<string, unknown>, kind: string): void {
  const list = assertStringArray(spec, kind);
  if (list === null) return;
  const others = ['valueFlags', 'booleanFlags', 'optionalValueFlags', ...INDEPENDENT_KINDS.filter((k) => k !== kind)];
  for (const other of others) {
    const clash = list.filter((f) => Array.isArray(spec[other]) && (spec[other] as unknown[]).includes(f));
    if (clash.length > 0) {
      throw new TypeError(
        `parseNamedArgs: spec.${kind} must be disjoint from spec.${other} — ` +
          `declared in both: ${clash.join(', ')}`,
      );
    }
  }
}

/**
 * First required flag (declaration order) whose extracted value is `null`
 * (absent or flag-shaped) or `''`, as an InvalidArgs result; else null.
 */
function missingRequired(spec: NamedArgSpec, data: ParsedNamedArgs): NamedArgsResult | null {
  for (const flag of spec.requiredFlags ?? []) {
    const value = data[flag];
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      return {
        ok: false,
        kind: 'InvalidArgs',
        arg: `--${flag}`,
        reason: `missing required flag --${flag} <value>`,
        exitReason: ERROR_REASON.USAGE,
      };
    }
  }
  return null;
}

/**
 * First `nonEmptyFlags` member (declaration order) that is present (`--f` or
 * `--f=` occurs) but whose extracted value is `null` or `''`, as an InvalidArgs
 * result with today's wording (`Missing value for --f`); else null.
 */
function missingValue(
  spec: NamedArgSpec,
  data: ParsedNamedArgs,
  occurrences: Map<string, Occurrence[]>,
): NamedArgsResult | null {
  for (const flag of spec.nonEmptyFlags ?? []) {
    if (!occurrences.has(flag)) continue;
    if (data[flag] === null || data[flag] === '') {
      return {
        ok: false,
        kind: 'InvalidArgs',
        arg: `--${flag}`,
        reason: `Missing value for --${flag}`,
        exitReason: ERROR_REASON.USAGE,
      };
    }
  }
  return null;
}

// One `--name` / `--name=value` token. `inline` is the text after `=` for an
// eq-form token (eqFlags only), null for a bare `--name`.
interface Occurrence {
  index: number;
  inline: string | null;
}

/** Single pass over argv: flag name -> its occurrences in argv order. */
function indexOccurrences(args: string[], eq: Set<string>): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>();
  args.forEach((tok, index) => {
    if (!isFlagToken(tok)) return;
    const eqAt = tok.indexOf('=');
    const eqName = eqAt > 2 ? tok.slice(2, eqAt) : null;
    const isEq = eqName !== null && eq.has(eqName);
    const name = isEq ? eqName : tok.slice(2);
    const list = map.get(name) ?? [];
    list.push({ index, inline: isEq ? tok.slice(eqAt + 1) : null });
    map.set(name, list);
  });
  return map;
}

/** The value an occurrence carries: `null` when absent, empty, or flag-shaped. */
function occurrenceValue(args: string[], occ: Occurrence): string | null {
  if (occ.inline !== null) return occ.inline === '' ? null : occ.inline;
  const next = args[occ.index + 1];
  return next !== undefined && !isFlagToken(next) ? next : null;
}

function extractValueFlag(
  args: string[],
  spec: NamedArgSpec,
  flag: string,
  occs: Occurrence[],
): string | string[] | null {
  if ((spec.repeatableFlags ?? []).includes(flag)) {
    return occs.map((o) => occurrenceValue(args, o)).filter((v): v is string => v !== null);
  }
  if (occs.length === 0) return null;
  const value = occurrenceValue(args, occs[0]);
  const bareEmpty = (spec.bareEmptyFlags ?? []).includes(flag) && occs[0].inline === null;
  return value === null && bareEmpty ? '' : value;
}

/**
 * Every occurrence of `--flag` starts a run of non-`--` tokens that ends at
 * the next list flag of the spec (gsd-tools.cjs `collectListFlagValues`).
 */
function collectListValues(args: string[], flag: string, stops: Set<string>): string[] {
  const values: string[] = [];
  args.forEach((a, i) => {
    if (a !== `--${flag}`) return;
    for (const b of args.slice(i + 1)) {
      if (stops.has(b)) break;
      if (isFlagToken(b)) continue;
      values.push(b);
    }
  });
  return values;
}

function extractData(
  args: string[],
  spec: NamedArgSpec,
  occurrences: Map<string, Occurrence[]>,
): ParsedNamedArgs {
  const data: ParsedNamedArgs = {};
  for (const flag of spec.valueFlags ?? []) {
    data[flag] = extractValueFlag(args, spec, flag, occurrences.get(flag) ?? []);
  }
  // Boolean and optional-value flags (#2932: `--wave`-shaped) are presence
  // tests; the optional value is deliberately not surfaced here.
  for (const flag of [...(spec.booleanFlags ?? []), ...(spec.optionalValueFlags ?? [])]) {
    data[flag] = occurrences.has(flag);
  }
  const listFlags = spec.listFlags ?? [];
  const stops = new Set(listFlags.map((f) => `--${f}`));
  for (const flag of listFlags) data[flag] = collectListValues(args, flag, stops);
  for (const flag of spec.multiwordFlags ?? []) data[flag] = parseMultiwordArg(args, flag);
  return data;
}

interface FlagSets {
  value: Set<string>;
  boolean: Set<string>;
  optional: Set<string>;
  eq: Set<string>;
  list: Set<string>;
  multiword: Set<string>;
  accepted: string[];
}

function buildFlagSets(spec: NamedArgSpec): FlagSets {
  const value = spec.valueFlags ?? [];
  const bool = spec.booleanFlags ?? [];
  const optional = spec.optionalValueFlags ?? [];
  const list = spec.listFlags ?? [];
  const multiword = spec.multiwordFlags ?? [];
  return {
    value: new Set(value),
    boolean: new Set(bool),
    optional: new Set(optional),
    eq: new Set(spec.eqFlags ?? []),
    list: new Set(list),
    multiword: new Set(multiword),
    accepted: [
      ...value.map((f) => `--${f} <value>`),
      ...bool.map((f) => `--${f}`),
      ...optional.map((f) => `--${f} [value]`),
      ...list.map((f) => `--${f} <values...>`),
      ...multiword.map((f) => `--${f} <words...>`),
    ],
  };
}

// A short flag is a dash followed by a letter; `-1` (negative number) and `-` are not flags.
const SHORT_FLAG_RE = /^-[A-Za-z]/;

/** Tokens consumed by the flag at `args[i]`, or null when the flag is not declared. */
function advanceOverFlag(args: string[], i: number, sets: FlagSets): number | null {
  const tok = args[i];
  const eqAt = tok.indexOf('=');
  if (eqAt > 2 && sets.eq.has(tok.slice(2, eqAt))) return 1;
  const name = tok.slice(2);
  const next = args[i + 1];
  const hasValue = next !== undefined && !isFlagToken(next);
  // A value flag whose next token is absent or flag-shaped resolves to `null`
  // in `data` — NOT an error (#3180/behavior-lock). Advance by 1 so the
  // following flag token is validated on its own merits.
  if (sets.value.has(name) || sets.optional.has(name)) return hasValue ? 2 : 1;
  if (sets.boolean.has(name) || sets.list.has(name)) return 1;
  if (sets.multiword.has(name)) {
    let n = 1;
    while (args[i + n] !== undefined && !isFlagToken(args[i + n])) n++;
    return n;
  }
  return null;
}

function unknownFlag(tok: string, sets: FlagSets, spec: NamedArgSpec): NamedArgsResult {
  const template = spec.unknownFlagMessage;
  const reason =
    template !== undefined
      ? template.split('{flag}').join(tok)
      : sets.accepted.length > 0
      ? `unknown flag ${formatDiagnosticToken(tok)}; accepted: ${sets.accepted.join(', ')}`
      : `unknown flag ${formatDiagnosticToken(tok)}; this command accepts no flags`;
  return { ok: false, kind: 'InvalidArgs', arg: tok, reason, exitReason: ERROR_REASON.USAGE };
}

/**
 * Left-to-right cursor walk from `spec.positionals`. Once a list flag has
 * been seen, non-flag tokens belong to its run (collectListFlagValues
 * semantics: a run is only ended by another list flag, which restarts it) and
 * are not stray positionals; `--` tokens inside a run are still validated.
 */
function walkTokens(args: string[], spec: NamedArgSpec): NamedArgsResult | null {
  const sets = buildFlagSets(spec);
  let inListRun = false;
  let i = spec.positionals === 'rest' ? args.length : spec.positionals;
  while (i < args.length) {
    const tok = args[i];
    if (spec.rejectShortFlags === true && SHORT_FLAG_RE.test(tok)) return unknownFlag(tok, sets, spec);
    if (isFlagToken(tok)) {
      const advance = advanceOverFlag(args, i, sets);
      if (advance === null) return unknownFlag(tok, sets, spec);
      if (sets.list.has(tok.slice(2))) inListRun = true;
      i += advance;
      continue;
    }
    if (!inListRun && spec.freePositionals !== true) {
      return {
        ok: false,
        kind: 'InvalidArgs',
        arg: tok,
        reason: `unexpected positional argument ${formatDiagnosticToken(tok)}`,
        exitReason: ERROR_REASON.USAGE,
      };
    }
    i += 1;
  }
  return null;
}

/** Split argv at the first literal `--` (passthroughAfter) at/after the positional boundary. */
function splitPassthrough(args: string[], spec: NamedArgSpec): { head: string[]; tail: string[] } {
  if (spec.passthroughAfter === undefined) return { head: args, tail: [] };
  const from = typeof spec.positionals === 'number' ? spec.positionals : 0;
  const at = args.indexOf(spec.passthroughAfter, from);
  return at === -1 ? { head: args, tail: [] } : { head: args.slice(0, at), tail: args.slice(at + 1) };
}

// Single predicate reused for both extraction (a value beginning with a
// single `-` is a value, not a flag) and validation (negative space N5).
// Exported for init-command-router's #3865 --phase alias normalization,
// which needs the same flag-shape test before deciding whether args[2] is a
// phase positional or a flag token.
export function isFlagToken(tok: string): boolean {
  return tok.startsWith('--');
}

// ─── parseNamedArgs ───────────────────────────────────────────────────────────

/**
 * Project argv tokens into typed named values, then strictly validate every
 * token past the caller's declared positional boundary.
 *
 * Extraction (unchanged semantics, #312): first occurrence wins; a value
 * flag whose next token is absent or starts with `--` yields `null` (this is
 * NOT a validation error — see the value-flag branch below); boolean flags
 * and optional-value flags (`optionalValueFlags`, #2932's `--wave` shape) are
 * presence tests. Kept as a single first-index Map so the flag loops don't
 * each re-scan argv — O(argv + flags) instead of O(flags * argv).
 *
 * Validation (skipped entirely when `positionals === 'rest'`): a single
 * left-to-right cursor walk from `spec.positionals`, per the design doc's
 * Kernighan's Law note — debuggable over clever, never a set-difference.
 */
export function parseNamedArgs(args: string[], spec: ScalarNamedArgSpec): NamedArgsResult<ScalarNamedArgs>;
export function parseNamedArgs(args: string[], spec: NamedArgSpec): NamedArgsResult;
export function parseNamedArgs(args: string[], spec: NamedArgSpec): NamedArgsResult {
  assertValidSpec(spec);
  const { head, tail } = splitPassthrough(args, spec);
  const occurrences = indexOccurrences(head, new Set(spec.eqFlags ?? []));
  const data = extractData(head, spec, occurrences);
  if (spec.passthroughAfter !== undefined) data['--'] = tail;

  const invalid =
    (spec.positionals === 'rest' ? null : walkTokens(head, spec)) ??
    missingValue(spec, data, occurrences) ??
    missingRequired(spec, data);
  return invalid ?? { ok: true, data };
}

/**
 * Thin projection over `parseNamedArgs`: on `ok:false` it calls
 * `fail(result.reason, result.exitReason)` and then throws.
 *
 * The trailing throw exists for two reasons: (1) TypeScript's control-flow
 * analysis needs a `never`-returning path so callers can destructure the
 * return value without a null check; (2) it is a fail-closed backstop — the
 * `fail` callbacks in this repo are `never`-returning at runtime (`io.error`
 * calls `process.exit(1)`) but are typed `void`, so if a caller ever passes a
 * `fail` that actually returns, this still halts instead of falling through
 * with a half-built `ParsedNamedArgs`.
 */
export function parseNamedArgsOrExit(
  args: string[],
  spec: ScalarNamedArgSpec,
  fail: (message: string, exitReason?: ErrorReasonValue) => void,
): ScalarNamedArgs;
export function parseNamedArgsOrExit(
  args: string[],
  spec: NamedArgSpec,
  fail: (message: string, exitReason?: ErrorReasonValue) => void,
): ParsedNamedArgs;
export function parseNamedArgsOrExit(
  args: string[],
  spec: NamedArgSpec,
  fail: (message: string, exitReason?: ErrorReasonValue) => void,
): ParsedNamedArgs {
  const result = parseNamedArgs(args, spec);
  if (!result.ok) {
    fail(result.reason, result.exitReason);
    throw new Error(`parseNamedArgsOrExit: fail() returned instead of exiting (arg: ${result.arg})`);
  }
  return result.data;
}

/**
 * Collect all tokens after --flag until the next --flag or end of args.
 */
export function parseMultiwordArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(`--${flag}`);
  if (idx === -1) return null;
  const tokens: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    tokens.push(args[i]);
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}
