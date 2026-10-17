'use strict';

/**
 * Per-line cost attribution for a `bash -x` trace whose PS4 stamps every
 * traced command with a millisecond timestamp, its line number and enclosing
 * function (#5473).
 *
 * The stamp is `<depth marks>@@<nonce>@@<epoch-ms>@@<lineno>@@<function>@@ `, so
 * one trace line looks like `++@@k3f9@@1760615775123@@271@@@@ MSG_SUFFIX=...`.
 * The nonce is a per-run random token: a traced value that merely LOOKS like a
 * stamp (hostile or accidental) cannot forge one without knowing it.
 *
 * WHAT A GAP MEANS. bash prints a trace line (and so evaluates PS4) AFTER it
 * has expanded the command's words and BEFORE it runs the command. The gap
 * between stamp i and stamp i+1 is therefore
 *
 *     execution of command i  +  expansion of command i+1
 *
 * which cannot be split from the trace alone. Both attributions are reported:
 * `afterMs` (the gap that FOLLOWS the line) is large for a line that EXECUTES
 * slowly (an external command, a `$(...)` already expanded); `beforeMs` (the
 * gap that PRECEDES it) is large for a line whose EXPANSION is slow (a
 * `${var//pat/x}` or `${var:off}` over a 112KB value, whose result is only
 * printed once it is computed). Neither alone is "the cost of the line".
 *
 * Every traced command also pays one stamp (a subshell and a perl); measure it
 * with a run of no-ops (see the CLI) and read gaps below it as zero.
 *
 * No I/O and no clock: every function returns a value computed from its
 * arguments. The CLI that runs bash is scripts/diagnose-validate-commit-phases.cjs.
 */

/** PS4 to hand to `bash -x`; `timestampCommand` prints the epoch milliseconds. */
function stampPs4(timestampCommand, nonce) {
  return `+@@${nonce}@@$(${timestampCommand})@@\${LINENO}@@\${FUNCNAME:-}@@ `;
}

/**
 * How the stamp reaches bash. Every other route failed somewhere:
 *   - an exported PS4: bash 5.x does not run the command substitution in a PS4
 *     it imported from the environment, so it silently degrades to `+ `;
 *   - BASH_ENV: bash reads the system bashrc INSTEAD of it in some
 *     environments (it did in the gsd-test tester container);
 *   - `bash -c '... . "$0"'`: puts an uncontrolled path inside a shell command.
 * So the script under test is run as an ordinary script that has ONE line
 * inserted after its shebang, which assigns PS4 (read from a sibling file, so
 * the stamp text is never quoted into shell code) and turns on xtrace. `$0`,
 * `exit` and sibling files then behave exactly as in a direct run (the CLI's
 * tests pin this against the real hook).
 */
const TRACE_PS4_FILE = 'xtrace-ps4.txt';
const INJECTED_LINES = 1;
const INJECTED_LINE = `PS4="$(cat "\${0%/*}/${TRACE_PS4_FILE}")"; set -x`;

/**
 * `scriptText` with the tracing line inserted after its shebang (or at the top
 * when it has none). The script must be run by a path containing a `/`, with
 * the PS4 text in TRACE_PS4_FILE beside it. Adds exactly INJECTED_LINES lines.
 */
function injectTracing(scriptText) {
  const text = String(scriptText);
  if (!text.startsWith('#!')) return `${INJECTED_LINE}\n${text}`;
  const eol = text.indexOf('\n');
  if (eol === -1) return `${text}\n${INJECTED_LINE}\n`;
  return `${text.slice(0, eol + 1)}${INJECTED_LINE}\n${text.slice(eol + 1)}`;
}

// What follows the depth marks and the nonce: `<epoch-ms>@@<lineno>@@<function>@@ `.
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
  const lines = String(text).split('\n');
  // A stream ends with the newline of its last line; that is a terminator, not
  // an empty continuation of the last command.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
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
 * Entries with their line numbers moved back by `injected` lines, so a stamp
 * reports the line of the ORIGINAL script, not of the instrumented copy.
 */
function shiftLines(entries, injected) {
  return entries.map((e) => ({ ...e, line: e.line - injected }));
}

/**
 * Attribute the gaps around each entry to its (function, line): `afterMs` is
 * the gap to the NEXT stamp, `beforeMs` the gap from the PREVIOUS one (see the
 * header for what each means). A clock that steps backwards counts as zero.
 *
 * @param {{ t: number, line: number, fn?: string, cmd: string }[]} entries
 * @returns {{ costs: { fn: string, line: number, afterMs: number, beforeMs: number, maxMs: number, count: number, sample: string }[], totalMs: number }}
 */
function phaseCosts(entries) {
  const byKey = new Map();
  const last = entries.length - 1;
  for (let i = 0; i <= last; i++) {
    const after = i < last ? Math.max(0, entries[i + 1].t - entries[i].t) : 0;
    const before = i > 0 ? Math.max(0, entries[i].t - entries[i - 1].t) : 0;
    const e = entries[i];
    const fn = e.fn || '';
    const key = `${fn}\u0000${e.line}`;
    const acc = byKey.get(key) || { fn, line: e.line, afterMs: 0, beforeMs: 0, maxMs: 0, count: 0, sample: '' };
    acc.afterMs += after;
    acc.beforeMs += before;
    acc.count += 1;
    const peak = Math.max(after, before);
    if (peak >= acc.maxMs) {
      acc.maxMs = peak;
      acc.sample = e.cmd;
    }
    byKey.set(key, acc);
  }
  const totalMs = entries.length > 1 ? Math.max(0, entries[last].t - entries[0].t) : 0;
  return { costs: [...byKey.values()], totalMs };
}

/** A line's weight when ranking: the larger of its two attributions. */
const peakMs = (c) => Math.max(c.afterMs, c.beforeMs);

/**
 * The `n` most expensive lines, costliest first; ties broken by function then
 * line number so the order is deterministic.
 */
function slowestLines(costs, n) {
  return [...costs]
    .sort((a, b) => peakMs(b) - peakMs(a) || (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0) || a.line - b.line)
    .slice(0, n);
}

/**
 * Elapsed time per run of `size` source lines of the script's top level, in
 * line order, plus one entry per function. `afterMs` summed over a region is
 * the time from its first stamp to the next region's, so regions roughly
 * partition the run: a coarse "which phase" view that needs no knowledge of
 * the script.
 *
 * @returns {{ label: string, afterMs: number }[]}
 */
function rollupByRegion(costs, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('region size must be a positive integer');
  const regions = new Map();
  for (const c of costs) {
    const start = Math.floor((c.line - 1) / size) * size + 1;
    const label = c.fn ? `in ${c.fn}()` : `lines ${start}-${start + size - 1}`;
    const from = c.fn ? Number.MAX_SAFE_INTEGER : start; // functions sort after the top level
    const acc = regions.get(label) || { label, from, afterMs: 0 };
    acc.afterMs += c.afterMs;
    regions.set(label, acc);
  }
  return [...regions.values()]
    .sort((a, b) => a.from - b.from || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .map(({ label, afterMs }) => ({ label, afterMs }));
}

/** One-line, length-bounded rendering of a traced command for a report. */
function abbreviate(cmd, max = 100) {
  const flat = String(cmd).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}… (${flat.length} chars)`;
}

module.exports = {
  stampPs4,
  TRACE_PS4_FILE,
  INJECTED_LINES,
  injectTracing,
  parseTimedXtrace,
  shiftLines,
  phaseCosts,
  peakMs,
  slowestLines,
  rollupByRegion,
  abbreviate,
};
