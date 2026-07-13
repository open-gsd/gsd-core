'use strict';

/**
 * Fake clock helper for deterministic lock tests (issue #453).
 *
 * Usage:
 *   const { makeFakeClock } = require('./helpers/clock.cjs');
 *   const clock = makeFakeClock(0); // start at t=0
 *   clock.advance(5000);            // jump 5 000 ms forward
 *   acquireStateLock(path, clock);  // no real waits; timeout/stale logic driven by advance()
 *
 * The fake clock returned by makeFakeClock() is compatible with the clock seam
 * accepted by acquireStateLock(statePath, clock) in state.cjs and
 * withPlanningLock(cwd, fn, clock) in planning-workspace.cjs.
 *
 * API
 * ───
 * now()          → returns the current virtual epoch milliseconds.
 * sleep(ms)      → records a sleep call without blocking; advances virtual time by ms.
 * advance(ms)    → advance the virtual clock by ms without sleeping. Use between
 *                  synchronous retries to simulate elapsed time.
 * sleepCalls     → array of ms values passed to sleep(), for assertion use.
 * nowValue       → current virtual milliseconds (same as calling now()).
 *
 * Design notes
 * ────────────
 * • sleep() advances the clock by the requested duration so that a retry loop
 *   checking `clock.now() - startedAt >= maxWaitMs` eventually trips the timeout
 *   without needing any real sleeps in between.
 * • advance() allows the test to simulate arbitrary elapsed time without triggering
 *   a sleep call (useful for driving the stale-lock check independently).
 * • Both now() and sleep() are intentionally synchronous so tests using them remain
 *   fully synchronous — no async needed for lock serialization / timeout assertions.
 */

/**
 * @param {number} [startMs=0] - initial virtual epoch milliseconds
 * @returns {{ now(): number, sleep(ms: number): void, advance(ms: number): void, sleepCalls: number[], nowValue: number }}
 */
function makeFakeClock(startMs) {
  if (startMs === undefined) startMs = 0;

  let _now = startMs;
  const _sleepCalls = [];

  const clock = {
    /** Return current virtual time (epoch ms). */
    now() {
      return _now;
    },

    /**
     * Record a sleep call and advance virtual time by ms.
     * Does NOT block.
     *
     * @param {number} ms
     */
    sleep(ms) {
      _sleepCalls.push(ms);
      _now += ms;
    },

    /**
     * Advance the virtual clock by ms without recording a sleep call.
     * Use to simulate time passing between lock attempts.
     *
     * @param {number} ms
     */
    advance(ms) {
      _now += ms;
    },

    /**
     * Return the virtual instant as an ISO 8601 string (UTC).
     * Mirrors realClock.nowIso() so fake clocks are drop-in substitutes.
     *
     * @returns {string} e.g. "2020-06-15T12:00:00.000Z"
     */
    nowIso() {
      return new Date(_now).toISOString();
    },

    /**
     * Return the virtual date as a YYYY-MM-DD string (UTC calendar day).
     * Mirrors realClock.today() so fake clocks are drop-in substitutes.
     *
     * @returns {string} e.g. "2020-06-15"
     */
    today() {
      return new Date(_now).toISOString().split('T')[0];
    },

    /**
     * Return the virtual date as a YYYY-MM-DD string in the HOST-LOCAL calendar
     * day. Mirrors realClock.localToday() so fake clocks are drop-in substitutes.
     * (#2136: operator-facing date-only fields use the local calendar day.)
     *
     * @returns {string} e.g. "2020-06-14" (local), may differ from today() near UTC midnight
     */
    localToday() {
      const d = new Date(_now);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return d.getFullYear() + '-' + mm + '-' + dd;
    },

    /** Array of ms values passed to sleep() in call order. */
    get sleepCalls() {
      return _sleepCalls;
    },

    /** Current virtual time (same as now()). */
    get nowValue() {
      return _now;
    },
  };

  return clock;
}

module.exports = { makeFakeClock };
