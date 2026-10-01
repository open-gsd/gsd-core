/**
 * MUST NOT COMPILE (#5170) — an unbranded verdict is not an `UnreadableVerdict`.
 *
 * `gateVerdict('unreadable', ...)` produces a plain `GateVerdict`: the brand
 * that `gateUnreadable` adds is what the `unreadable` arm demands, so the only
 * constructor that satisfies it is the one that names the outcome.
 *
 * `OFFENDING` is the marker the test pins the diagnostic to.
 */

import { verdictFromEvidence, evidenceNone } from '../../../src/gate-evidence.cjs';
import { gateVerdict } from '../../../src/gate-verdict.cjs';

const OFFENDING = gateVerdict('unreadable', false, {});

export const verdict = verdictFromEvidence(evidenceNone<string>(), {
  found: () => gateVerdict('pass', false, {}),
  none: () => gateVerdict('skip', false, {}),
  unreadable: () => OFFENDING,
});
