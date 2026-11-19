"use strict";
/**
 * Deterministic clock seam for lock modules (ADR-457 build-at-publish: the
 * hand-written bin/lib/clock.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * Production code uses `realClock` (the default). Test code passes in a
 * `makeFakeClock()` instance to drive lock timing without real wall-clock
 * waits or Atomics.wait calls.
 *
 * Both methods in realClock use exactly the same system primitives that
 * acquireStateLock and withPlanningLock used inline before the seam was
 * introduced:
 *   - now()   → Date.now()
 *   - sleep() → Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.realClock = void 0;
// Module-level Atomics.wait buffer reused across every realClock.sleep() call.
// The buffer value is always 0 (never written), so reuse is semantically
// identical to allocating a fresh buffer each time.
const _realSleepBuf = new Int32Array(new SharedArrayBuffer(4));
/**
 * Parse GSD_NOW_MS to a valid pinned epoch millisecond value, or return null.
 *
 * Accepts ONLY strict decimal integer strings within JS Date bounds
 * (abs(ms) <= 8.64e15).  Rejects empty strings, whitespace-only, floats
 * ('12.5'), scientific notation ('1e30'), and out-of-range values.
 *
 * Returns null (fall back to Date.now()) for any invalid or absent input.
 * Returns null when GSD_TEST_MODE is not set.
 */
function _pinnedNowMs() {
    if (!process.env.GSD_TEST_MODE)
        return null;
    const raw = process.env.GSD_NOW_MS;
    if (typeof raw !== 'string')
        return null;
    const t = raw.trim();
    if (!/^-?\d+$/.test(t))
        return null; // reject '', 'abc', '1e30', '12.5'
    const ms = Number(t);
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15)
        return null; // Date-valid bounds
    return ms;
}
exports.realClock = {
    /**
     * Return current epoch milliseconds.
     *
     * When both GSD_TEST_MODE and GSD_NOW_MS are set (subprocess time-pin adapter,
     * issue #474), returns the pinned millisecond value so all date-stamping in the
     * subprocess SUT is deterministic.  In production, falls back to Date.now().
     *
     * Only strict decimal integer strings within JS Date bounds are accepted as pins.
     * Any other value (empty string, float, scientific notation, out-of-range) falls
     * back to Date.now() to prevent RangeError from new Date(ms).toISOString().
     */
    now() {
        const pinned = _pinnedNowMs();
        if (pinned !== null)
            return pinned;
        return Date.now();
    },
    /**
     * Return the current instant as an ISO 8601 string (UTC).
     * Uses this.now() so the subprocess time-pin adapter is honoured.
     *
     * @returns e.g. "2020-06-15T12:00:00.000Z"
     */
    nowIso() {
        return new Date(this.now()).toISOString();
    },
    /**
     * Return today's date as a YYYY-MM-DD string (UTC calendar day).
     * Uses this.now() so the subprocess time-pin adapter is honoured.
     *
     * @returns e.g. "2020-06-15"
     */
    today() {
        return this.nowIso().split('T')[0];
    },
    /**
     * Return today's date as a YYYY-MM-DD string in the HOST-LOCAL calendar day.
     * Uses this.now() so the subprocess time-pin adapter (GSD_NOW_MS) is honoured
     * exactly as today()/nowIso() are — deterministic when GSD_NOW_MS and TZ are
     * both pinned (#2136).
     *
     * Operator-facing date-only fields (last_activity, "completed <date>", etc.)
     * must use the local calendar day: an operator reads them as "the day I did
     * this", and they must never name a day ahead of `last_updated`'s local date.
     * `today()` (UTC) stays the source for internal/cosmetic stamps.
     *
     * @returns e.g. "2020-06-14" (local), which may differ from today() near UTC midnight
     */
    localToday() {
        const d = new Date(this.now());
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '-' + mm + '-' + dd;
    },
    /**
     * Synchronous sleep via Atomics.wait.
     * This is the identical primitive acquireStateLock and withPlanningLock used
     * inline before the seam.  Atomics.wait on a shared buffer that is never
     * notified times out after exactly `ms` milliseconds without spinning the CPU.
     *
     * @param ms - milliseconds to sleep
     */
    sleep(ms) {
        Atomics.wait(_realSleepBuf, 0, 0, ms);
    },
};
