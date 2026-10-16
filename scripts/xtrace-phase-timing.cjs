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
 * `exit` behave exactly as when it is run directly. The one visible difference:
 * the sourced file's top level reports FUNCNAME `source`, which the parser
 * folds to "no function".
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

module.exports = { stampPs4, tracedBashArgs, traceEnv, parseTimedXtrace, parseTracedScript, phaseCosts, slowestLines, abbreviate };
