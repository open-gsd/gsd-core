/**
 * Gate Predicate Evaluator — issue #2008 / ADR-2008
 *
 * Pure, deps-injected evaluator for capability gate `check.predicate` blocks.
 *
 * Background: the loop-resolver renders active gate hooks (carrying their
 * `check.predicate` declarations) but, prior to #2008, nothing EVALUATED a
 * declared predicate for non-built-in capabilities — `check.query` was the only
 * enforced shape (dispatched via `gsd_run check <query>`), and `check.predicate`
 * was declaration-only. This module is the generic evaluation path.
 *
 * The workflow gate-dispatch calls this evaluator (via the `gsd_run check predicate`
 * subcommand, implemented by gate-predicate.cts) for any gate whose `check` carries a
 * `predicate` instead of a `query`. The evaluator dispatches by `predicate.kind`
 * and returns the existing `{ block, message }` gate contract. A THROWN error
 * (malformed predicate / unknown kind) is mapped by the CLI wrapper to a
 * non-zero check-command exit, which the workflow's two-step gate contract treats
 * as a step-1 command failure (routed per the gate's `onError`).
 *
 * Built-in kinds: `command-exit-zero` runs a declared command in a bounded
 * `sh -c` subprocess; `artifact-frontmatter-equals` compares a declared value
 * with frontmatter read through injected artifact dependencies. See ADR-2008
 * for the full contracts.
 *
 * This is a leaf pure module: no fs, no child_process, no config — the subprocess
 * seam is injected so the evaluator is trivially testable without spawning.
 */

import path from 'node:path';
import { escapeRegex } from './pattern.cjs';

// ─── Public constants ─────────────────────────────────────────────────────────

/** Default command timeout for `command-exit-zero` (30s). Matches execTool default. */
const COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS = 30_000;

/** Hard cap on the stderr/stdout tail embedded in the gate `message`. */
const COMMAND_MAX_OUTPUT_CHARS = 2000;

/** Hard cap on the declared command length (defense-in-depth against ARGV overflow / abuse). */
const COMMAND_MAX_LENGTH = 4096;

/** Predicate kinds this evaluator recognises (extensible — add to KIND_TABLE). */
const EVALUATOR_KINDS = Object.freeze(['command-exit-zero', 'artifact-frontmatter-equals']);

/** The env name behind each PredicateContext key: the one place a placeholder name meets its value. */
const ENV_CONTEXT_KEYS = Object.freeze({ GSD_PHASE_NUMBER: 'phaseNumber', GSD_PHASE_DIR: 'phaseDir', GSD_PHASE_REQ_IDS: 'phaseReqIds' } as const);

/** Placeholders a declared command expands from the gate shell environment, in addition to its own vars. */
const INTERPOLATION_VAR_NAMES = Object.freeze(Object.keys(ENV_CONTEXT_KEYS));

/** The prefix of every GSD environment name. */
const ENV_PREFIX = 'GSD_';

/** The pre-#5482 spellings. They collide with ordinary shell variables, so a command that uses one is refused. */
const LEGACY_VAR_NAMES = Object.freeze(INTERPOLATION_VAR_NAMES.map((name) => name.slice(ENV_PREFIX.length)));

// ─── Types (internal; runtime API is the `export =` block) ────────────────────

interface PredicateContext {
  /** Project root — also the cwd of the bounded subprocess. */
  cwd: string;
  phaseNumber?: string;
  phaseDir?: string;
  phaseReqIds?: string;
}

interface BoundedShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface PredicateDeps {
  /** `env` holds GSD_PHASE_NUMBER, GSD_PHASE_DIR and GSD_PHASE_REQ_IDS: the shell expands `${GSD_PHASE_*}` from it, so a value never becomes command text. */
  runBoundedShell(opts: { command: string; cwd: string; timeoutMs: number; env: Record<string, string> }): BoundedShellResult;
  /** All distinct matches for the artifact, in any order; `[]` when absent. Entries must be realpaths: the evaluator dedupes by string, so a symlink to one file counts once only if both names resolve to the same path. */
  findPhaseArtifact(phaseDir: string, artifactSuffix: string): string[];
  readFrontmatter(filePath: string): Record<string, unknown>;
}

interface PredicateResult {
  block: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const namesPattern = (names: readonly string[]): string => `\\$\\{?(${names.map(escapeRegex).join('|')})\\b`;
const PLACEHOLDER_AT_RE = new RegExp(namesPattern(INTERPOLATION_VAR_NAMES), 'y');
// Only the braced spelling was ever a GSD placeholder; a bare `$PHASE_DIR` is the gate's own shell variable.
const LEGACY_PLACEHOLDER_RE = new RegExp(`\\$\\{(${LEGACY_VAR_NAMES.map(escapeRegex).join('|')})\\}`);

/**
 * Throw when the command uses a pre-#5482 placeholder (`${PHASE_DIR}`), in any quoting form: GSD no
 * longer sets it, so the shell would expand an empty or foreign value. The message names the replacement.
 */
function assertNoLegacyPlaceholder(command: string): void {
  const name = LEGACY_PLACEHOLDER_RE.exec(command)?.[1];
  if (name !== undefined) {
    throw new Error(`gate command uses \${${name}}, which GSD no longer sets: write "\${${ENV_PREFIX}${name}}" (double-quoted); sh expands it from the environment`);
  }
}

/** Throw when `command[i]` starts a placeholder in a span `sh` never expands (single quotes, `$'...'`, a quoted here-document). */
function assertNotLiteralPlaceholder(command: string, i: number): void {
  PLACEHOLDER_AT_RE.lastIndex = i;
  const name = PLACEHOLDER_AT_RE.exec(command)?.[1];
  if (name !== undefined) {
    throw new Error(`gate command single-quotes \${${name}}, which sh never expands: write "\${${name}}" in double quotes`);
  }
}

// A here-document opener: `<<`, optional `-`, then the delimiter word (quoted: the body is literal).
const HEREDOC_OPEN_RE = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_]\w*))/y;

interface QuoteCtx {
  kind: 'none' | 'sub' | 'tick' | 'double' | 'single' | 'ansi' | 'heredoc' | 'literal-heredoc';
  delimiter?: string;
  stripTabs?: boolean;
}

/** The end index of the line starting at `i` when it is the delimiter line of here-document `top`; -1 otherwise. */
function endsHeredoc(command: string, i: number, top: QuoteCtx): number {
  const eol = command.indexOf('\n', i);
  const end = eol === -1 ? command.length : eol;
  const line = command.slice(i, end);
  return (top.stripTabs ? line.replace(/^\t+/, '') : line) === top.delimiter ? end : -1;
}

/**
 * Throw when a placeholder sits where `sh` never expands it: the gate would test the literal text
 * `${GSD_PHASE_DIR}` and pass on a path that does not exist. The throw is the gate's existing "unevaluable"
 * path (a `usage` failure). One walk follows every shell quoting state with a stack: single and double quotes,
 * `$'...'`, backslash, `#` comments, `$(...)`, `(...)`, backticks and here-documents (a quoted delimiter makes
 * the body literal). A quote character pairs only inside its own state, so an apostrophe in a comment, a
 * double-quoted string or an unquoted here-document body pairs with nothing.
 */
function assertNoSingleQuotedPlaceholder(command: string): void {
  const stack: QuoteCtx[] = [{ kind: 'none' }];
  const pending: QuoteCtx[] = [];
  let dollarAt = -2;
  for (let i = 0; i < command.length; i++) {
    const top = stack[stack.length - 1];
    const c = command[i];
    const prev = command[i - 1] ?? '';
    if ((top.kind === 'heredoc' || top.kind === 'literal-heredoc') && prev === '\n') {
      const end = endsHeredoc(command, i, top);
      if (end !== -1) {
        stack.pop();
        i = end - 1;
        continue;
      }
    }
    if (top.kind === 'single' || top.kind === 'ansi' || top.kind === 'literal-heredoc') {
      if (c === "'" && top.kind !== 'literal-heredoc') stack.pop();
      else if (c === '\\' && top.kind === 'ansi') i++;
      else if (c === '$') assertNotLiteralPlaceholder(command, i);
    } else if (c === '\\') {
      i++;
    } else if (c === '`') {
      if (top.kind === 'tick') stack.pop();
      else stack.push({ kind: 'tick' });
    } else if (c === '$' && command[i + 1] === '(') {
      stack.push({ kind: 'sub' });
      i++;
    } else if (top.kind === 'double' || top.kind === 'heredoc') {
      if (c === '"' && top.kind === 'double') stack.pop();
    } else if (c === '$') {
      dollarAt = i;
    } else if (c === '#' && (i === 0 || /[\s;&|()]/.test(prev))) {
      const eol = command.indexOf('\n', i);
      if (eol === -1) return;
      i = eol - 1;
    } else if (c === "'") {
      stack.push({ kind: dollarAt === i - 1 ? 'ansi' : 'single' });
    } else if (c === '"') {
      stack.push({ kind: 'double' });
    } else if (c === '(') {
      stack.push({ kind: 'sub' });
    } else if (c === ')') {
      if (top.kind === 'sub') stack.pop();
    } else if (c === '<' && command[i + 1] === '<' && prev !== '<') {
      HEREDOC_OPEN_RE.lastIndex = i;
      const m = HEREDOC_OPEN_RE.exec(command);
      if (m) {
        const literal = m[2] !== undefined || m[3] !== undefined;
        pending.push({ kind: literal ? 'literal-heredoc' : 'heredoc', delimiter: m[2] ?? m[3] ?? m[4], stripTabs: m[1] === '-' });
        i += m[0].length - 1;
      }
    } else if (c === '\n' && pending.length > 0) {
      stack.push(pending.shift() as QuoteCtx);
    }
  }
}

/** Cap a string at COMMAND_MAX_OUTPUT_CHARS so gate messages stay context-bounded. */
function trimToMax(s: string): string {
  return s.length > COMMAND_MAX_OUTPUT_CHARS ? s.slice(0, COMMAND_MAX_OUTPUT_CHARS) : s;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// ─── Kind: command-exit-zero ──────────────────────────────────────────────────

function evaluateCommandExitZero(
  predicate: Record<string, unknown>,
  ctx: PredicateContext,
  deps: PredicateDeps,
): PredicateResult {
  const command = predicate['command'];
  if (!isNonEmptyString(command)) {
    throw new Error('command-exit-zero predicate requires a non-empty string "command"');
  }
  if (command.length > COMMAND_MAX_LENGTH) {
    throw new Error(`command-exit-zero predicate "command" exceeds max length ${COMMAND_MAX_LENGTH}`);
  }

  let timeoutMs = COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS;
  const rawTimeout = predicate['timeout'];
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error('command-exit-zero predicate "timeout" must be a positive finite number (seconds)');
    }
    timeoutMs = Math.floor(rawTimeout * 1000);
  }

  // GSD pastes nothing into the command text: every value reaches `sh` as an environment value (unset => '').
  const env = Object.fromEntries(Object.entries(ENV_CONTEXT_KEYS).map(([name, key]) => [name, ctx[key] ?? '']));
  assertNoLegacyPlaceholder(command);
  assertNoSingleQuotedPlaceholder(command);
  const res = deps.runBoundedShell({ command, cwd: ctx.cwd, timeoutMs, env });

  if (res.timedOut) {
    return {
      block: true,
      message: trimToMax(`command timed out after ${Math.round(timeoutMs / 1000)}s: ${res.stderr || command}`),
      details: { kind: 'command-exit-zero', timedOut: true, signal: res.signal },
    };
  }

  if (res.exitCode === 0) {
    return {
      block: false,
      message: 'command exited 0',
      details: { kind: 'command-exit-zero', exitCode: 0 },
    };
  }

  // Non-zero (incl. null exit from a signal kill) => block. Surface code + stderr/stdout tail.
  const code = res.exitCode === null ? '<none>' : String(res.exitCode);
  const tail = trimToMax(res.stderr || res.stdout || '');
  const message = tail ? `command exited ${code}: ${tail}` : `command exited ${code}`;
  return {
    block: true,
    message: trimToMax(message),
    details: { kind: 'command-exit-zero', exitCode: res.exitCode, signal: res.signal },
  };
}

// ─── Kind: artifact-frontmatter-equals ──────────────────────────────────────────

function evaluateArtifactFrontmatterEquals(
  predicate: Record<string, unknown>,
  ctx: PredicateContext,
  deps: PredicateDeps,
): PredicateResult {
  const artifactSuffix = predicate['artifact'];
  if (!isNonEmptyString(artifactSuffix)) {
    throw new Error('artifact-frontmatter-equals predicate requires a non-empty string "artifact"');
  }
  const field = predicate['field'];
  if (!isNonEmptyString(field)) {
    throw new Error('artifact-frontmatter-equals predicate requires a non-empty string "field"');
  }
  const expectedValue = predicate['equals'];
  if (expectedValue === undefined) {
    throw new Error('artifact-frontmatter-equals predicate requires an "equals" key');
  }
  const targetDir = isNonEmptyString(ctx.phaseDir) ? ctx.phaseDir : ctx.cwd;
  // Plain `.sort()` (no locale) so the outcome never depends on directory listing order (#5313).
  // Set: finders return realpaths, so a symlink to the same file is one artifact, not two.
  const found: unknown = deps.findPhaseArtifact(targetDir, artifactSuffix);
  // A pre-#5313 dep returned `string | null`; a silent null -> "not found" block or per-character spread would mislead.
  if (!Array.isArray(found)) {
    throw new Error('predicate deps "findPhaseArtifact" must return an array of paths');
  }
  const candidates = [...new Set(found as string[])].sort();
  if (candidates.length === 0) {
    return {
      block: true,
      message: `Artifact matching ${artifactSuffix} not found in ${targetDir}`,
      details: { kind: 'artifact-frontmatter-equals', artifactNotFound: true },
    };
  }

  // #5313: never pick one of several matches (listing order is OS-dependent); a throw would fail open via onError.
  if (candidates.length > 1) {
    const names = candidates.map((c) => path.relative(targetDir, c).split(path.sep).join('/')).join(', ');
    return {
      block: true,
      message: `Multiple artifacts match ${artifactSuffix} in ${targetDir}: ${names}; remove or rename all but one`,
      details: { kind: 'artifact-frontmatter-equals', ambiguous: true, candidates },
    };
  }

  const fm = deps.readFrontmatter(candidates[0]);

  const actualValue = fm[field];
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const expectedStr = typeof expectedValue === 'object' ? JSON.stringify(expectedValue) : String(expectedValue);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const actualStr = typeof actualValue === 'object' ? JSON.stringify(actualValue) : String(actualValue);

  const matches = actualValue === expectedValue || (actualValue !== undefined && actualValue !== null && actualStr === expectedStr);
  if (matches) {
    return {
      block: false,
      message: `Frontmatter field "${field}" matches expected value (${expectedStr})`,
      details: { kind: 'artifact-frontmatter-equals', match: true },
    };
  }

  return {
    block: true,
    message: `Frontmatter field "${field}" in ${artifactSuffix} is ${actualStr}, expected ${expectedStr}`,
    details: { kind: 'artifact-frontmatter-equals', match: false, actual: actualValue, expected: expectedValue },
  };
}

// ─── Kind dispatch table ──────────────────────────────────────────────────────

const KIND_TABLE: Record<string, (p: Record<string, unknown>, ctx: PredicateContext, deps: PredicateDeps) => PredicateResult> = {
  'command-exit-zero': evaluateCommandExitZero,
  'artifact-frontmatter-equals': evaluateArtifactFrontmatterEquals,
};

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Evaluate a capability gate `check.predicate`.
 *
 * Returns `{ block, message }` for any successfully-recognised predicate.
 * THROWS for a malformed predicate, missing context/deps, or unknown `kind` —
 * the CLI wrapper converts a throw into a non-zero check-command exit so the
 * workflow's `onError` (step-1) contract applies. This keeps the gate fail-closed
 * without conflating an evaluator bug with a legitimate gate-block decision.
 */
function evaluatePredicate(predicate: unknown, context: unknown, deps: unknown): PredicateResult {
  if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) {
    throw new Error('predicate must be an object');
  }
  const ctx = context as PredicateContext;
  if (!ctx || typeof ctx.cwd !== 'string' || ctx.cwd.length === 0) {
    throw new Error('predicate context requires a non-empty "cwd"');
  }
  const d = deps as PredicateDeps;
  if (!d || typeof d.runBoundedShell !== 'function') {
    throw new Error('predicate deps require a "runBoundedShell" function');
  }

  const pred = predicate as Record<string, unknown>;
  const kind = pred['kind'];
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error('predicate.kind must be a non-empty string');
  }
  if (kind === 'artifact-frontmatter-equals') {
    if (typeof d.findPhaseArtifact !== 'function') {
      throw new Error('predicate deps require a "findPhaseArtifact" function');
    }
    if (typeof d.readFrontmatter !== 'function') {
      throw new Error('predicate deps require a "readFrontmatter" function');
    }
  }

  const handler = KIND_TABLE[kind];
  if (!handler) {
    throw new Error(`Unknown predicate kind: "${kind}". Known kinds: ${EVALUATOR_KINDS.join(', ')}`);
  }
  return handler(pred, ctx, d);
}

export = {
  evaluatePredicate,
  evaluateCommandExitZero,
  COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_CHARS,
  COMMAND_MAX_LENGTH,
  EVALUATOR_KINDS,
  INTERPOLATION_VAR_NAMES,
};
