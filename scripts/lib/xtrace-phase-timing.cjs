'use strict';

/**
 * Per-line cost attribution for a `bash -x` trace whose PS4 stamps every
 * traced command with a millisecond timestamp and its line number (#5473).
 *
 * The stamp is `<depth marks>@@<epoch-ms>@@<lineno>@@ `, so one trace line
 * looks like `++@@1760615775123@@271@@ MSG_SUFFIX=...`. The cost of a traced
 * command is the gap to the NEXT stamp: bash expands PS4 immediately before
 * running the command, so the gap is that command's own execution time (plus
 * one constant PS4 overhead, reported as `floorMs`).
 *
 * Pure functions only: no I/O, no clock. The CLI that produces the trace is
 * scripts/diagnose-validate-commit-phases.cjs.
 */

/** PS4 to hand to `bash -x`; `stampPs4(cmd)` embeds the timestamp command. */
function stampPs4(timestampCommand) {
  return `+@@$(${timestampCommand})@@\${LINENO}@@ `;
}

// `+` repeats once per subshell/nesting level, so `\++` captures the depth.
const STAMP = /^(\++)@@(\d+)@@(\d+)@@ ?/;

/**
 * Parse a stamped trace. Lines with no stamp are continuations of the
 * previous command (a traced value that itself contains newlines) and are
 * folded into it; text before the first stamp is ignored.
 *
 * @param {string} text
 * @returns {{ t: number, line: number, depth: number, cmd: string }[]}
 */
function parseTimedXtrace(text) {
  const entries = [];
  for (const raw of String(text).split('\n')) {
    const m = STAMP.exec(raw);
    if (m) {
      entries.push({
        t: Number(m[2]),
        line: Number(m[3]),
        depth: m[1].length,
        cmd: raw.slice(m[0].length),
      });
    } else if (entries.length > 0) {
      entries[entries.length - 1].cmd += `\n${raw}`;
    }
  }
  return entries;
}

/**
 * Attribute each entry's cost (gap to the next stamp) to its source line.
 *
 * @param {{ t: number, line: number, cmd: string }[]} entries
 * @returns {{ costs: { line: number, totalMs: number, maxMs: number, count: number, sample: string }[], floorMs: number, totalMs: number }}
 */
function phaseCosts(entries) {
  const byLine = new Map();
  const gaps = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const gap = Math.max(0, entries[i + 1].t - entries[i].t);
    gaps.push(gap);
    const e = entries[i];
    const acc = byLine.get(e.line) || { line: e.line, totalMs: 0, maxMs: 0, count: 0, sample: '' };
    acc.totalMs += gap;
    acc.count += 1;
    if (gap >= acc.maxMs) {
      acc.maxMs = gap;
      acc.sample = e.cmd;
    }
    byLine.set(e.line, acc);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const floorMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const totalMs = entries.length > 1 ? Math.max(0, entries[entries.length - 1].t - entries[0].t) : 0;
  return { costs: [...byLine.values()], floorMs, totalMs };
}

/**
 * The `n` most expensive lines, costliest first; ties broken by line number
 * so the order is deterministic.
 */
function slowestLines(costs, n) {
  return [...costs].sort((a, b) => b.totalMs - a.totalMs || a.line - b.line).slice(0, n);
}

/** One-line, length-bounded rendering of a traced command for a report. */
function abbreviate(cmd, max = 100) {
  const flat = String(cmd).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}… (${flat.length} chars)`;
}

module.exports = { stampPs4, parseTimedXtrace, phaseCosts, slowestLines, abbreviate };
