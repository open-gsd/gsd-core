'use strict';

/**
 * Preload fixture for #5784 — a clock seam for gsd-secret-read-guard.js's
 * stdin stall timer, in the SPAWNED hook (`node --require <this> <hook>`).
 * Everything it observes it reports on fd 3, one line per event:
 *
 * - `armed <ms>` for each setTimeout the hook arms, with the delay as the
 *   number Node schedules by; `fired <ms>` just before such a timer's callback
 *   runs. A cell reads which delay the hook asked for, and whether the timer
 *   is what ended the run, without measuring elapsed time.
 * - `data <bytes>` for each chunk delivered to a `data` listener the hook
 *   registers on process.stdin, before the listener runs. A cell reads that
 *   the hook itself received its payload, not only that the parent wrote it.
 *
 * GSD_TEST_STALL_TIMER steers the timer, never the delay the hook asked for
 * (which is still what `armed` and `fired` report):
 * - `<ms>` schedules the callback at that delay instead, so a held-open stall
 *   cell ends in milliseconds;
 * - `after-data:<ms>` schedules it that many ms after the hook's own `data`
 *   listener receives its first chunk, so a cell that writes a payload into a
 *   held-open pipe has it delivered before the timer can fire, on any host.
 *   Until then the timer is parked, and clearTimeout on the hook's handle
 *   cancels both;
 * - `park` arms a real, clearable timer that is never due (2^31-1 ms), so the
 *   hook's callback can never run, and a cell whose stdin closes is decided by
 *   the hook's verdict on any host, however slow.
 * Unset, the timer runs at the hook's own delay.
 *
 * Same `--require` seam as the context-monitor preloads; one-shot subprocess,
 * nothing restored. The hook itself reads neither the variable nor fd 3.
 */

const fs = require('node:fs');

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const mode = process.env.GSD_TEST_STALL_TIMER || '';
const park = mode === 'park';
const afterData = /^after-data:([1-9][0-9]*)$/.exec(mode);
const override = Number(mode);

// after-data: each parked handle the hook holds, mapped to its callback and,
// once the first chunk has arrived, the real timer that will run it.
const pending = new Map();

function report(line) {
  try {
    fs.writeSync(3, `${line}\n`);
  } catch {
    // fd 3 is not open: the spawn did not ask for the report.
  }
}

globalThis.setTimeout = function stallTimerSeam(fn, ms, ...args) {
  const asked = Number(ms);
  report(`armed ${asked}`);
  // A parked timer is still a real, clearable handle; it is just never due.
  if (park) return realSetTimeout(() => {}, 2 ** 31 - 1);
  const fire = () => {
    report(`fired ${asked}`);
    fn(...args);
  };
  if (afterData) {
    const handle = realSetTimeout(() => {}, 2 ** 31 - 1);
    pending.set(handle, { fire, timer: null });
    return handle;
  }
  const delay = Number.isFinite(override) && override > 0 ? override : asked;
  return realSetTimeout(fire, delay);
};

globalThis.clearTimeout = function stallClearSeam(handle) {
  const entry = pending.get(handle);
  if (entry) {
    if (entry.timer !== null) realClearTimeout(entry.timer);
    pending.delete(handle);
  }
  return realClearTimeout(handle);
};

// The first chunk starts every after-data timer still waiting; later chunks
// start nothing.
function startAfterData() {
  for (const entry of pending.values()) {
    if (entry.timer === null) entry.timer = realSetTimeout(entry.fire, Number(afterData[1]));
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
