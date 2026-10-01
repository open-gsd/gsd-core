/**
 * MUST NOT COMPILE (#5170) — "could not look" reported as a pass.
 *
 * The `unreadable` arm of `verdictFromEvidence` is typed to return an
 * `UnreadableVerdict`; a passing `GateVerdict` is not assignable to it, so the
 * gate cannot turn evidence it never saw into a passing outcome.
 *
 * `OFFENDING` is the marker the test pins the diagnostic to.
 */

import { verdictFromEvidence, evidenceFound } from '../../../src/gate-evidence.cjs';
import { gateVerdict } from '../../../src/gate-verdict.cjs';

const OFFENDING = gateVerdict('pass', false, {});

export const verdict = verdictFromEvidence(evidenceFound('x'), {
  found: () => gateVerdict('pass', false, {}),
  none: () => gateVerdict('skip', false, {}),
  unreadable: () => OFFENDING,
});
