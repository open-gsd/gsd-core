/**
 * GateVerdict — the value a gate module returns instead of printing (#5139, epic #5056,
 * ADR-5057 §4 first bullet, design D1).
 *
 * A gate module decides; the command router formats. A gate imports no io module and performs no
 * direct console/stdout/stderr write (ESLint-enforced) — it returns one of two shapes:
 *
 *   - `GateVerdict`      the gate reached an answer. `outcome` names it, `block` is the gate's
 *                        own blocking decision (set explicitly by each arm, never derived from
 *                        `outcome`), and `payload` is the exact ordered object the router
 *                        serializes (insertion order is the wire order).
 *   - `GateUsageFailure` the caller invoked the gate wrongly (missing argument, escaping path).
 *                        The router turns it into `error(message, code)`.
 *
 * Pure: no I/O, no imports.
 */

/**
 * How a gate's arm ended. `block` is carried separately: a gate can be advisory yet block, etc.
 * `empty` (#5170) is "the gate ran and the scope it evaluates is genuinely empty" (a plan with no
 * `must_haves.artifacts` block): distinct from `unreadable` (could not look) and from `pass`.
 */
export type GateOutcome = 'pass' | 'block' | 'skip' | 'advisory' | 'unreadable' | 'empty';

declare const unreadableBrand: unique symbol;

/**
 * A verdict whose evidence could not be read (#5170, ADR-5057 §4). Branded so the `unreadable` arm of
 * `verdictFromEvidence` (src/gate-evidence.cts) can only return one: a passing `GateVerdict` is not
 * assignable to this type, so "could not look" cannot be reported as a pass at compile time.
 */
export interface UnreadableVerdict extends GateVerdict {
  readonly outcome: 'unreadable';
  readonly [unreadableBrand]: true;
}

/** The gate reached an answer. */
export interface GateVerdict {
  outcome: GateOutcome;
  /** The gate's own blocking decision, set explicitly by each arm. */
  block: boolean;
  /** The exact ordered object the router serializes today; frozen. */
  payload: Readonly<Record<string, unknown>>;
}

/** The caller invoked the gate wrongly. */
export interface GateUsageFailure {
  failure: { code: string; message: string };
}

export type GateResult = GateVerdict | GateUsageFailure;

/**
 * The `GateUsageFailure.failure.code` values a gate module produces. A gate module may not import
 * `./io.cjs` (whose `ERROR_REASON` owns these wire strings), so it names them here; the router
 * hands the code straight to `error()`. Values are pinned equal to `ERROR_REASON.USAGE` /
 * `ERROR_REASON.SDK_MISSING_ARG` by the cutover-equivalence goldens.
 */
export const GATE_FAILURE_CODE = Object.freeze({
  USAGE: 'usage',
  SDK_MISSING_ARG: 'sdk_missing_arg',
});

/**
 * Build a verdict. `payload` is copied (insertion order preserved) and the copy frozen, so a
 * verdict cannot be mutated after the gate returned it.
 */
export function gateVerdict(outcome: GateOutcome, block: boolean, payload: Record<string, unknown>): GateVerdict {
  return { outcome, block, payload: Object.freeze({ ...payload }) };
}

/**
 * Build the verdict for evidence that could not be read. `block` is the gate's own policy for that
 * arm (unchanged by this outcome); the exit status is derived from the outcome, never from `block`.
 */
export function gateUnreadable(block: boolean, payload: Record<string, unknown>): UnreadableVerdict {
  return gateVerdict('unreadable', block, payload) as UnreadableVerdict;
}

/** Build a usage failure: exactly `{ failure: { code, message } }`. */
export function gateUsageFailure(code: string, message: string): GateUsageFailure {
  return { failure: { code, message } };
}

/** Narrow a `GateResult` (or any value) to a `GateUsageFailure`. */
export function isGateUsageFailure(result: unknown): result is GateUsageFailure {
  if (result === null || typeof result !== 'object') return false;
  const failure = (result as { failure?: unknown }).failure;
  return typeof failure === 'object' && failure !== null;
}
