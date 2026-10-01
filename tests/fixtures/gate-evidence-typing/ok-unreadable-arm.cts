/**
 * MUST COMPILE (#5170) — the positive control for the unreadable-arm typing.
 *
 * The `unreadable` arm returns an `UnreadableVerdict` built by `gateUnreadable`.
 * Proves the harness, the imports and the option set are sound, so the `bad-*`
 * fixture failing means the brand is doing the work.
 */

import { verdictFromEvidence, evidenceFound } from '../../../src/gate-evidence.cjs';
import { gateVerdict, gateUnreadable } from '../../../src/gate-verdict.cjs';

export const verdict = verdictFromEvidence(evidenceFound('x'), {
  found: () => gateVerdict('pass', false, {}),
  none: () => gateVerdict('skip', false, {}),
  unreadable: (reason) => gateUnreadable(true, { reason }),
});
