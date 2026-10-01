/**
 * Gate exit — the exit status follows the verdict (#5170, epic #5056, ADR-5057 §4 fourth bullet).
 *
 * `gateExitOutcome(verdict, mode)` is the one total function from a gate verdict to a registered
 * outcome name:
 *
 *   pass | skip | advisory -> PASS
 *   block                  -> PASS in `payload` mode, FAIL in `status` mode
 *   unreadable             -> UNAVAILABLE in both modes (the gate could not look; never exit 0)
 *
 * `payload` is the `check <verb>` dispatch contract: the verdict is delivered on stdout and read
 * from `.block`, so a blocking verdict is still a delivered answer (exit 0) and a non-zero status
 * means the command could not run. `status` is for verbs whose callers branch on the exit status
 * (`phase uat-passed`, `verify artifacts`): a negative verdict is exit 1.
 *
 * `declareGateExit` records the outcome in the pending-outcome cell AFTER the verb's `output()`
 * has run — `output()` rewrites that cell on every call, so declaring first would be erased.
 * A `PASS` is not declared: it is the default, and leaving the cell as `output()` set it keeps a
 * payload that legitimately carries an `error` key on its existing contract.
 */
import type { GateOutcome } from './gate-verdict.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExit = require('./cli-exit.cjs');

export type GateExitMode = 'payload' | 'status';

/** The registered outcome names a gate verdict can project to. */
export type GateExitOutcome = 'PASS' | 'FAIL' | 'UNAVAILABLE';

export function gateExitOutcome(
  verdict: { readonly outcome: GateOutcome },
  mode: GateExitMode,
): GateExitOutcome {
  switch (verdict.outcome) {
    case 'unreadable':
      return 'UNAVAILABLE';
    case 'block':
      return mode === 'status' ? 'FAIL' : 'PASS';
    case 'pass':
    case 'skip':
    case 'advisory':
      return 'PASS';
  }
}

/** Declare the exit outcome for a verdict. Call after `output()`, never before. */
export function declareGateExit(
  verdict: { readonly outcome: GateOutcome },
  mode: GateExitMode,
): GateExitOutcome {
  const outcome = gateExitOutcome(verdict, mode);
  if (outcome !== 'PASS') cliExit.declareOutcome(outcome);
  return outcome;
}
