'use strict';

/**
 * @file allowlist-ratchet.cjs
 *
 * Reusable "better than a count ratchet" primitives for CI guards.
 *
 * ## Motivation (issue #597)
 *
 * A count ratchet (`assert(offenders.length <= N)`) has a masking blind spot:
 * fixing one offender and introducing a new one keeps the count constant, so a
 * novel defect slips through green.  These helpers enforce on IDENTITY instead,
 * making every individual offender visible and requiring monotonic progress
 * toward zero.
 *
 * ## Design
 *
 * Both functions are pure (no I/O, no global state).  The `fail` callback is
 * injected by the caller so the same logic can be used with `node:assert.fail`,
 * a custom throw, or a message-collector in unit tests.
 */

/**
 * Assert that `current` offenders are all within the known allowlist, and that
 * every entry in the allowlist still offends (forcing the allowlist to shrink
 * as defects are fixed).
 *
 * Fails when:
 * - Any id in `current` is NOT in `known` → novel offender introduced.
 * - Any id in `known` is NOT in `current` → stale allowlist entry must be
 *   pruned so the guard ratchets toward zero (the ratchet-DOWN direction).
 *
 * ## Masking blind spot this prevents (issue #597)
 *
 * A count ratchet (`assert(count <= N)`) allows one offender to be silently
 * replaced by another while the count stays at N.  By asserting on identity
 * instead, every new offender is caught by name, and every fixed offender
 * forces the allowlist to shrink.
 *
 * @param {object} opts
 * @param {string}   opts.label      - Human-readable name for the guard (used
 *                                     in failure messages).
 * @param {Iterable<string>} opts.current - The offending ids found in the
 *                                     current run.
 * @param {Iterable<string>} opts.known   - The allowlisted ids (baseline).
 * @param {function(string): void} opts.fail - Callback invoked with a
 *                                     descriptive message on any violation.
 *                                     Pass `require('node:assert').fail`, a
 *                                     custom thrower, or a collector.  The
 *                                     function is NOT imported here so callers
 *                                     control the failure mode.
 * @param {string}  [opts.pruneHint] - Optional hint appended to the stale-
 *                                     entry failure message (e.g. the name of
 *                                     the allowlist file to edit).
 * @returns {{ novel: string[], stale: string[] }} Sorted arrays of novel ids
 *   (in current but not known) and stale ids (in known but not current).
 */
function assertWithinAllowlist({ label, current, known, fail, pruneHint }) {
  const currentSet = new Set(current);
  const knownSet = new Set(known);

  const novel = [...currentSet].filter((id) => !knownSet.has(id)).sort();
  const stale = [...knownSet].filter((id) => !currentSet.has(id)).sort();

  if (novel.length > 0) {
    const list = novel.map((id) => `  - ${id}`).join('\n');
    fail(
      `[${label}] ${novel.length} NEW offender(s) introduced — fix at the source; do not just add to the allowlist.\n${list}`
    );
  }

  if (stale.length > 0) {
    const list = stale.map((id) => `  - ${id}`).join('\n');
    const hint = pruneHint ? `\n(${pruneHint})` : '';
    fail(
      `[${label}] ${stale.length} allowlisted id(s) no longer offend and MUST be pruned so the guard ratchets toward zero.${hint}\n${list}`
    );
  }

  return { novel, stale };
}

/**
 * Assert that an artifact's measured maximum stays within a declared ceiling,
 * and that the ceiling itself does not creep above the high-water mark (budgets
 * may only decrease, not increase over time).
 *
 * Fails when:
 * - `actualMax > ceiling`           → regression: artifact exceeds budget.
 * - `ceiling - actualMax > grace`   → ceiling sits too far above the measured
 *                                     value; tighten it toward `actualMax`.
 *
 * ## Masking blind spot this prevents (issue #597)
 *
 * A plain `assert(size <= ceiling)` with a ceiling set generously high allows
 * the artifact to grow unchecked as long as it stays under the ceiling.  The
 * `grace` band forces the ceiling to stay close to the high-water mark,
 * ensuring that any upward creep is immediately visible.
 *
 * @param {object} opts
 * @param {string}   opts.label     - Human-readable name for the guard (used
 *                                    in failure messages).
 * @param {number}   opts.actualMax - The measured value (e.g. bundle size in
 *                                    bytes, line count).
 * @param {number}   opts.ceiling   - The declared budget ceiling.
 * @param {number}   opts.grace     - Maximum allowed slack (`ceiling -
 *                                    actualMax`) before the ceiling is
 *                                    considered too loose.
 * @param {function(string): void} opts.fail - Callback invoked with a
 *                                    descriptive message on any violation.
 * @returns {{ ok: boolean, slack: number }} Whether both checks passed and the
 *   current slack value.
 */
function assertTightCeiling({ label, actualMax, ceiling, grace, fail }) {
  const slack = ceiling - actualMax;
  let ok = true;

  if (actualMax > ceiling) {
    ok = false;
    fail(
      `[${label}] Regression: artifact value ${actualMax} exceeds budget ceiling ${ceiling}. ` +
        `Raise the ceiling to at most ${actualMax} only if the increase is justified.`
    );
  } else if (slack > grace) {
    ok = false;
    fail(
      `[${label}] Ceiling ${ceiling} sits too far above the high-water mark ${actualMax} ` +
        `(slack ${slack} > grace ${grace}). Tighten the ceiling toward ${actualMax}. ` +
        `Budgets may only decrease.`
    );
  }

  return { ok, slack };
}

module.exports = { assertWithinAllowlist, assertTightCeiling };
