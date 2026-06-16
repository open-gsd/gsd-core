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

/**
 * Assert that each artifact's measured size matches a committed per-file
 * baseline snapshot.  Growth, shrinkage, additions, and removals are each
 * surfaced by name — there is no aggregate "max" that can mask one file's
 * growth behind another file's size.
 *
 * Fails when, for the union of `current` and `baseline` keys:
 * - `current[name] > baseline[name]` → GROWTH: the file grew past its recorded
 *   size.  Regenerate the baseline and justify the growth in the PR (or extract
 *   the content lazily).  This is the headline guard.
 * - `current[name] < baseline[name]` → STALE: the file shrank but the baseline
 *   still records the old (larger) size.  Regenerate to auto-tighten — the
 *   per-file analogue of `assertWithinAllowlist`'s stale-entry rule, so the
 *   snapshot can only ratchet downward.
 * - name in `current` but not `baseline` → ADDED: a new artifact with no
 *   recorded baseline.  Regenerate to record it.
 * - name in `baseline` but not `current` → REMOVED: an orphaned baseline entry
 *   whose artifact no longer exists.  Regenerate to drop it.
 *
 * ## Why per-file, not a tier max (issue #1074)
 *
 * A `max(group) within grace` ceiling only binds the single largest file in the
 * group; every other file inherits that ceiling and can grow silently beneath
 * it.  Recording each file's exact size removes the masking blind spot — the
 * same reason `assertWithinAllowlist` enforces on identity rather than a count
 * (issue #597).
 *
 * @param {object} opts
 * @param {string} opts.label   - Human-readable guard name (used in messages).
 * @param {Object<string, number>} opts.current  - Measured sizes by name.
 * @param {Object<string, number>} opts.baseline - Committed sizes by name.
 * @param {function(string): void} opts.fail - Callback invoked once per
 *                                    non-empty violation category with a
 *                                    descriptive message.  Injected so callers
 *                                    control the failure mode (assert.fail, a
 *                                    thrower, or a collector in unit tests).
 * @param {string} [opts.updateHint] - Optional remediation hint appended to
 *                                    every failure message (e.g. the regen
 *                                    command).
 * @returns {{ grown: Array<{name:string,from:number,to:number,delta:number}>,
 *             shrunk: Array<{name:string,from:number,to:number,delta:number}>,
 *             added: string[], removed: string[] }}
 *   Sorted-by-name breakdown of every difference.
 */
function assertFileBaseline({ label, current, baseline, fail, updateHint }) {
  const currentNames = new Set(Object.keys(current));
  const baselineNames = new Set(Object.keys(baseline));

  const added = [...currentNames].filter((n) => !baselineNames.has(n)).sort();
  const removed = [...baselineNames].filter((n) => !currentNames.has(n)).sort();

  const grown = [];
  const shrunk = [];
  const shared = [...currentNames].filter((n) => baselineNames.has(n)).sort();
  for (const name of shared) {
    const from = baseline[name];
    const to = current[name];
    if (to > from) grown.push({ name, from, to, delta: to - from });
    else if (to < from) shrunk.push({ name, from, to, delta: from - to });
  }

  const hint = updateHint ? `\n${updateHint}` : '';

  if (grown.length > 0) {
    const list = grown
      .map((g) => `  - ${g.name}: ${g.from} → ${g.to} (+${g.delta})`)
      .join('\n');
    fail(
      `[${label}] ${grown.length} file(s) grew past the committed baseline. ` +
        `Regenerate the baseline and justify the growth in your PR, or extract the content lazily.\n${list}${hint}`
    );
  }

  if (shrunk.length > 0) {
    const list = shrunk
      .map((s) => `  - ${s.name}: ${s.from} → ${s.to} (-${s.delta})`)
      .join('\n');
    fail(
      `[${label}] ${shrunk.length} file(s) are SMALLER than the baseline — the snapshot is stale ` +
        `and MUST be regenerated so the budget ratchets downward.\n${list}${hint}`
    );
  }

  if (added.length > 0) {
    const list = added.map((n) => `  - ${n}`).join('\n');
    fail(
      `[${label}] ${added.length} file(s) are not in the baseline — regenerate to record them.\n${list}${hint}`
    );
  }

  if (removed.length > 0) {
    const list = removed.map((n) => `  - ${n}`).join('\n');
    fail(
      `[${label}] ${removed.length} baseline entry(ies) no longer exist — regenerate to drop them.\n${list}${hint}`
    );
  }

  return { grown, shrunk, added, removed };
}

module.exports = { assertWithinAllowlist, assertTightCeiling, assertFileBaseline };
