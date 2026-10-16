'use strict';

/**
 * Per-line cost attribution for a `bash -x` trace whose PS4 stamps every
 * traced command with a millisecond timestamp, its line number and enclosing
 * function (#5473).
 *
 * The stamp is `<depth marks>@@<nonce>@@<epoch-ms>@@<lineno>@@<function>@@ `, so
 * one trace line looks like `++@@k3f9@@1760615775123@@271@@@@ MSG_SUFFIX=...`.
 * The cost of a traced command is the gap to the NEXT stamp: bash expands PS4
 * immediately before running the command, so the gap is that command's own
 * execution time PLUS one stamp's own overhead (measure it with a run of no-op
 * commands; see the CLI).
 *
 * The nonce is a per-run random token: a traced value that merely LOOKS like a
 * stamp (hostile or accidental) cannot forge one without knowing it.
 *
 * bash 3.2 numbers LINENO relative to the enclosing function, so a stamp inside
 * a function carries its function name and the line is function-relative.
 *
 * Pure functions only: no I/O, no clock. The CLI that produces the trace is
 * scripts/diagnose-validate-commit-phases.cjs.
 */

/** PS4 to hand to `bash -x`; `timestampCommand` prints the epoch milliseconds. */
function stampPs4(timestampCommand, nonce) {
  return `+@@${nonce}@@$(${timestampCommand})@@\${LINENO}@@\${FUNCNAME:-}@@ `;
}

// After the depth marks and the nonce: `<epoch-ms>@@<lineno>@@<function>@@ `.
const STAMP_TAIL = /^(\d+)@@(\d+)@@([^@]*)@@ ?/;

/**
 * Parse a stamped trace. Lines with no stamp are continuations of the
 * previous command (a traced value that itself contains newlines) and are
 * folded into it; text before the first stamp is ignored.
 *
 * @param {string} text
 * @param {string} nonce the nonce given to stampPs4
 * @returns {{ t: number, line: number, depth: number, fn: string, cmd: string }[]}
 */
function parseTimedXtrace(text, nonce) {
  // The nonce is matched as a literal prefix, never compiled into a pattern.
  const head = `@@${nonce}@@`;
  const entries = [];
  for (const raw of String(text).split('\n')) {
    let depth = 0;
    while (raw[depth] === '+') depth++;
    const tail = depth > 0 && raw.startsWith(head, depth)
      ? STAMP_TAIL.exec(raw.slice(depth + head.length))
      : null;
    if (tail) {
      entries.push({
        t: Number(tail[1]),
        line: Number(tail[2]),
        depth,
        fn: tail[3],
        cmd: raw.slice(depth + head.length + tail[0].length),
      });
    } else if (entries.length > 0) {
      entries[entries.length - 1].cmd += `\n${raw}`;
    }
  }
  return entries;
}

/**
 * Attribute each entry's cost (gap to the next stamp) to its (function, line).
 *
 * @param {{ t: number, line: number, fn?: string, cmd: string }[]} entries
 * @returns {{ costs: { fn: string, line: number, totalMs: number, maxMs: number, count: number, sample: string }[], floorMs: number, totalMs: number }}
 */
function phaseCosts(entries) {
  const byKey = new Map();
  const gaps = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const gap = Math.max(0, entries[i + 1].t - entries[i].t);
    gaps.push(gap);
    const e = entries[i];
    const fn = e.fn || '';
    const key = `${fn}\u0000${e.line}`;
    const acc = byKey.get(key) || { fn, line: e.line, totalMs: 0, maxMs: 0, count: 0, sample: '' };
    acc.totalMs += gap;
    acc.count += 1;
    if (gap >= acc.maxMs) {
      acc.maxMs = gap;
      acc.sample = e.cmd;
    }
    byKey.set(key, acc);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const floorMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const totalMs = entries.length > 1 ? Math.max(0, entries[entries.length - 1].t - entries[0].t) : 0;
  return { costs: [...byKey.values()], floorMs, totalMs };
}

/**
 * The `n` most expensive lines, costliest first; ties broken by function then
 * line number so the order is deterministic.
 */
function slowestLines(costs, n) {
  return [...costs]
    .sort((a, b) => b.totalMs - a.totalMs || (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0) || a.line - b.line)
    .slice(0, n);
}

/** One-line, length-bounded rendering of a traced command for a report. */
function abbreviate(cmd, max = 100) {
  const flat = String(cmd).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}… (${flat.length} chars)`;
}

module.exports = { stampPs4, parseTimedXtrace, phaseCosts, slowestLines, abbreviate };
