'use strict';

/**
 * Preload fixture for #5784 — a clock seam for gsd-secret-read-guard.js's
 * stdin stall timer, in the SPAWNED hook (`node --require <this> <hook>`).
 * Everything it observes it reports on fd 3, one line per event:
 *
 * - `armed <ms>` for each timer the hook arms through setTimeout, with the
 *   delay as the number Node schedules by; `fired <ms>` just before such a
 *   timer's callback runs. A cell reads which delay the hook asked for, and
 *   whether the timer is what ended the run, without measuring elapsed time.
 * - `refreshed <ms>` whenever refresh() runs on a timer the hook armed, by any
 *   route to it (the handle's method or the Timeout prototype's), so a cell
 *   can tell a timer that is restarted from one that is not.
 * - `data <bytes>` for each chunk delivered to a `data` listener the hook
 *   registers on process.stdin, before the listener runs. A cell reads that
 *   the hook itself received its payload, not only that the parent wrote it.
 *
 * The seam replaces setTimeout, clearTimeout and clearInterval on both
 * globalThis and node:timers, and resolves a clear by a timer's numeric id to
 * the timer, so a hook arms and cancels through it however it spells the call.
 * A restart it cannot see (another timer API, say) is caught by behaviour
 * instead: the stdin-timer test file's unsteered fed cell.
 *
 * GSD_TEST_STALL_TIMER steers the timer, never the delay the hook asked for
 * (which is still what `armed` and `fired` report):
 * - `<ms>` schedules the callback at that delay instead, so a held-open stall
 *   cell ends in milliseconds;
 * - `after-data:<ms>` schedules it that many ms after the hook's own `data`
 *   listener receives its first chunk (`after-data:<ms>:<n>`: its n-th), so a
 *   cell that writes into a held-open pipe has those chunks delivered before
 *   the timer can fire, on any host. Until then the timer is parked, and a
 *   clear or a refresh() of the hook's timer reaches the scheduled one too; a
 *   timer armed after that chunk is scheduled at `<ms>` at once;
 * - `park` arms a real, clearable timer that is never due (2^31-1 ms), so the
 *   hook's callback can never run, and a cell whose stdin closes is decided by
 *   the hook's verdict on any host, however slow.
 * Unset, the timer runs at the hook's own delay.
 *
 * Same `--require` seam as the context-monitor preloads; one-shot subprocess,
 * nothing restored. The hook itself reads neither the variable nor fd 3.
 */

const fs = require('node:fs');
const timers = require('node:timers');

const realSetTimeout = timers.setTimeout;
const realClearTimeout = timers.clearTimeout;
const realClearInterval = timers.clearInterval;
const mode = process.env.GSD_TEST_STALL_TIMER || '';
const park = mode === 'park';
const afterData = /^after-data:([1-9][0-9]*)(?::([1-9][0-9]*))?$/.exec(mode);
const afterDataMs = afterData ? Number(afterData[1]) : 0;
const startAtChunk = afterData && afterData[2] ? Number(afterData[2]) : 1;
const override = Number(mode);

// Every timer the hook armed, mapped to the delay it asked for.
const hookTimers = new Map();
// after-data: each parked timer the hook holds, mapped to its callback and,
// once its starting chunk has arrived, the real timer that will run it.
const pending = new Map();
let chunks = 0;
let started = false;

function report(line) {
  try {
    fs.writeSync(3, `${line}\n`);
  } catch {
    // fd 3 is not open: the spawn did not ask for the report.
  }
}

function stallTimerSeam(fn, ms, ...args) {
  const asked = Number(ms);
  report(`armed ${asked}`);
  const fire = () => {
    report(`fired ${asked}`);
    fn(...args);
  };
  let handle;
  if (park) {
    // A parked timer is still a real, clearable handle; it is just never due.
    handle = realSetTimeout(() => {}, 2 ** 31 - 1);
  } else if (afterData && !started) {
    handle = realSetTimeout(() => {}, 2 ** 31 - 1);
    pending.set(handle, { fire, timer: null });
  } else {
    const delay = afterData ? afterDataMs : (Number.isFinite(override) && override > 0 ? override : asked);
    handle = realSetTimeout(fire, delay);
  }
  hookTimers.set(handle, asked);
  return handle;
}

// A clear may name the timer or its numeric id (what `+timer` gives).
function hookTimerFor(ref) {
  if (hookTimers.has(ref)) return ref;
  if (typeof ref !== 'number' && typeof ref !== 'string') return null;
  for (const handle of hookTimers.keys()) {
    if (Number(handle) === Number(ref)) return handle;
  }
  return null;
}

function cancelScheduled(ref) {
  const handle = hookTimerFor(ref);
  const entry = handle === null ? undefined : pending.get(handle);
  if (entry) {
    if (entry.timer !== null) realClearTimeout(entry.timer);
    pending.delete(handle);
  }
}

function clearTimeoutSeam(ref) {
  cancelScheduled(ref);
  return realClearTimeout(ref);
}

function clearIntervalSeam(ref) {
  cancelScheduled(ref);
  return realClearInterval(ref);
}

for (const target of [globalThis, timers]) {
  target.setTimeout = stallTimerSeam;
  target.clearTimeout = clearTimeoutSeam;
  target.clearInterval = clearIntervalSeam;
}

// refresh() lives on the Timeout prototype, so the seam wraps it there: a call
// through the handle or through the prototype both arrive here.
const probe = realSetTimeout(() => {}, 2 ** 31 - 1);
const timeoutPrototype = Object.getPrototypeOf(probe);
realClearTimeout(probe);
const realRefresh = timeoutPrototype.refresh;
timeoutPrototype.refresh = function stallRefreshSeam() {
  const asked = hookTimers.get(this);
  if (asked !== undefined) {
    report(`refreshed ${asked}`);
    const entry = pending.get(this);
    if (entry && entry.timer !== null) realRefresh.call(entry.timer);
  }
  return realRefresh.call(this);
};

// The chunk the mode names starts every after-data timer still waiting; from
// then on a new timer is scheduled at once (stallTimerSeam).
function startAfterData() {
  chunks += 1;
  if (started || chunks < startAtChunk) return;
  started = true;
  for (const entry of pending.values()) {
    if (entry.timer === null) entry.timer = realSetTimeout(entry.fire, afterDataMs);
  }
}

const stdin = process.stdin;
const realOn = stdin.on;
stdin.on = function stdinDataSeam(event, listener) {
  if (event !== 'data') return realOn.call(this, event, listener);
  return realOn.call(this, event, (chunk) => {
    report(`data ${Buffer.byteLength(chunk)}`);
    if (afterData) startAfterData();
    listener(chunk);
  });
};
