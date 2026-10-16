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
 * bash numbers LINENO relative to the enclosing function in some versions, so
 * a stamp inside a function carries its function name.
 *
 * No I/O and no clock: every function returns a value computed from its
 * arguments. The CLI that runs bash is scripts/diagnose-validate-commit-phases.cjs.
 */

/** PS4 to hand to `bash -x`; `timestampCommand` prints the epoch milliseconds. */
function stampPs4(timestampCommand, nonce) {
  return `+@@${nonce}@@$(${timestampCommand})@@\${LINENO}@@\${FUNCNAME:-}@@ `;
}

/**
 * The PS4 must reach bash as an in-shell ASSIGNMENT, not as an inherited
 * environment variable: bash 5.x does not run the command substitution in a PS4
 * it imported from the environment, so an exported PS4 silently degrades to a
 * plain `+ `. It cannot ride on a startup file either (BASH_ENV): bash reads
 * the system bashrc INSTEAD of BASH_ENV in some environments (it did in the
 * gsd-test tester container), and the trace falls back to `+ ` with no error.
 *
 * So the script runs inside a `bash -c` whose prologue assigns PS4, turns on
 * xtrace and SOURCES the script. `$0` is the script path, so `dirname "$0"` and
 * `exit` behave exactly as when it is run directly (the CLI's tests pin this
 * against the real hook). The one visible difference: the sourced file's top
 * level may report FUNCNAME `source`, which the parser folds to "no function".
 */
const PS4_ENV_VAR = 'GSD_XTRACE_PS4';
const TRACE_PROLOGUE = `PS4="$${PS4_ENV_VAR}"; set -x; . "$0"`;

/** argv (after the bash binary) that runs `script` (an absolute path) traced. */
function tracedBashArgs(script) {
  return ['-c', TRACE_PROLOGUE, script];
}

/** `base` plus the PS4 handed to the prologue. */
function traceEnv(base, ps4) {
  return { ...base, [PS4_ENV_VAR]: ps4 };
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
        // `source` is the sourced script's own top level, not a function (see tracedBashArgs).
        fn: tail[3] === 'source' ? '' : tail[3],
        cmd: raw.slice(depth + head.length + tail[0].length),
      });
    } else if (entries.length > 0) {
      entries[entries.length - 1].cmd += `\n${raw}`;
    }
  }
  return entries;
}

/**
 * parseTimedXtrace for a run made with tracedBashArgs: depth 1 is the prologue's
 * own `. script` (its line number belongs to the `-c` string, not the script),
 * so only deeper entries are the script's commands.
 */
function parseTracedScript(text, nonce) {
  return parseTimedXtrace(text, nonce).filter((e) => e.depth > 1);
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
 * the time from its first stamp to the next region's, so regions partition the
 * run: a coarse "which phase" view that needs no knowledge of the script.
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
  tracedBashArgs,
  traceEnv,
  parseTimedXtrace,
  parseTracedScript,
  phaseCosts,
  peakMs,
  slowestLines,
  rollupByRegion,
  abbreviate,
};
