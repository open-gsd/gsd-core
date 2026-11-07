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

/** Placeholders a declared command expands from the gate shell environment, in addition to its own vars. */
const INTERPOLATION_VAR_NAMES = Object.freeze(['PHASE_NUMBER', 'PHASE_DIR', 'PHASE_REQ_IDS']);

/** The `reason` a thrown gate-command error carries, so a caller branches on a value and never on message text. */
const GATE_COMMAND_REASON = Object.freeze({ SINGLE_QUOTED_NON_INERT: 'single_quoted_non_inert' });

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
  /** `env` holds PHASE_NUMBER, PHASE_DIR and PHASE_REQ_IDS: the shell expands `${PHASE_*}` from it, so a value that is not shell-inert never becomes command text. */
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

const PLACEHOLDER_SRC = `\\$\\{(${INTERPOLATION_VAR_NAMES.map(escapeRegex).join('|')})\\}`;
const INTERPOLATION_RE = new RegExp(PLACEHOLDER_SRC, 'g');
const PLACEHOLDER_AT_RE = new RegExp(PLACEHOLDER_SRC, 'y');
// Characters that no shell treats as syntax, bare or quoted. A value made of these only is safe as command text.
const SHELL_INERT_RE = /^[A-Za-z0-9._/@+=:,-]*$/;

/**
 * Paste a placeholder's value into the command text only when the value is shell-inert, so a gate that
 * single-quotes it ('${PHASE_NUMBER}') still receives it. Any other value stays a `${...}` for `sh` to
 * expand from the environment, where it is data and never parsed as command text.
 */
function interpolate(command: string, env: Record<string, string>): string {
  return command.replace(INTERPOLATION_RE, (whole, name: string): string => {
    const value = env[name] ?? '';
    return SHELL_INERT_RE.test(value) ? value : whole;
  });
}

/**
 * Throw when a placeholder sits in the single-quote state of the command and its value is not shell-inert:
 * `sh` never expands inside single quotes, so the gate would test the literal text `${PHASE_DIR}` and pass on
 * a path that does not exist. The throw is the gate's existing "unevaluable" path (onError). The walk follows
 * the POSIX quote states (single, double, backslash), so an apostrophe inside double quotes pairs with nothing.
 */
function assertNoSingleQuotedNonInert(command: string, env: Record<string, string>): void {
  let state: 'none' | 'single' | 'double' = 'none';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (state === 'single') {
      if (c === "'") {
        state = 'none';
      } else if (c === '$') {
        PLACEHOLDER_AT_RE.lastIndex = i;
        const name = PLACEHOLDER_AT_RE.exec(command)?.[1];
        if (name !== undefined && !SHELL_INERT_RE.test(env[name] ?? '')) {
          throw Object.assign(new Error(`gate command single-quotes \${${name}}, whose value is not shell-inert: double-quote the placeholder`), {
            reason: GATE_COMMAND_REASON.SINGLE_QUOTED_NON_INERT,
          });
        }
      }
    } else if (c === '\\') {
      i++;
    } else if (c === "'" && state === 'none') {
      state = 'single';
    } else if (c === '"') {
      state = state === 'none' ? 'double' : 'none';
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

  // Every value reaches `sh` as an environment value (unset => ''); see interpolate for what is also pasted.
  const env = { PHASE_NUMBER: ctx.phaseNumber ?? '', PHASE_DIR: ctx.phaseDir ?? '', PHASE_REQ_IDS: ctx.phaseReqIds ?? '' };
  assertNoSingleQuotedNonInert(command, env);
  const interpolated = interpolate(command, env);
  const res = deps.runBoundedShell({ command: interpolated, cwd: ctx.cwd, timeoutMs, env });

  if (res.timedOut) {
    return {
      block: true,
      message: trimToMax(`command timed out after ${Math.round(timeoutMs / 1000)}s: ${res.stderr || interpolated}`),
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
  interpolate,
  COMMAND_EXIT_ZERO_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_OUTPUT_CHARS,
  COMMAND_MAX_LENGTH,
  EVALUATOR_KINDS,
  INTERPOLATION_VAR_NAMES,
  GATE_COMMAND_REASON,
};
