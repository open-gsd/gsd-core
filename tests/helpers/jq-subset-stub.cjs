#!/usr/bin/env node
'use strict';

/**
 * A `jq` stand-in for the documented shell blocks tests extract and run (#5170).
 *
 * The Tester Image does not ship `jq` (a bash block that calls it dies with "jq: command not found",
 * exit 127, before the logic under test runs), and a test must not depend on a tool the image lacks.
 * This script implements EXACTLY the filters the extracted blocks use, with jq's own semantics for
 * them, and refuses any other filter loudly (exit 3), so a block that grows a new `jq` filter fails the
 * test instead of silently passing through a lookalike.
 *
 *   jq [-e] [-r] '<filter>'     reads one JSON document on stdin (-e: FILTERS only)
 *
 * Semantics kept from jq: `//` yields its right side when the left is `false` or `null` (an empty
 * string is truthy); `.a.b` on a document without `a` is `null`; `-e` exits 1 when the last output is
 * `false` or `null`, 0 otherwise; `-r` prints a string without quotes.
 *
 * Agreement with jq is PINNED, not asserted in general: the 13 documents x 2 filters (plus 5 for
 * `.reason//""`) in tests/gate-consumer-exit-awareness.test.cjs carry expected values measured from
 * real jq. KNOWN DIVERGENCES (each pinned there, or with the stream filters' pins named below; none is
 * reachable from the gate handler's, update-plan-progress's, phase.list-plans' or frontmatter.get's JSON):
 *   - empty stdin to a FILTERS filter: jq exits 4 under -e (0 and no output without it); the stub exits 2
 *     like invalid JSON;
 *   - a `.data` that is a string or an array, or a top-level array: jq errors (exit 5, "Cannot index ...");
 *     the stub reads the missing field as null (PASSED -> false, MESSAGE -> the default);
 *   - an object printed by -r: jq pretty-prints it over several lines, the stub prints compact JSON (this
 *     holds for STREAMS too; `.plans[]` never meets it, as phase.list-plans' `plans` holds only strings);
 *   - a number printed: jq keeps the document's literal (`1.0`, `1E+3`), the stub prints JavaScript's
 *     (`1`, `1000`); no filter here outputs a number from those answers;
 *   - an object under `.plans`: jq's `.plans[]` yields its values in document order, the stub in
 *     JavaScript's property order (integer-like keys first); phase.list-plans' `plans` is always an array;
 *   - invalid JSON: jq 1.8.1 exits 5; the stub exits 2;
 *   - several JSON documents on stdin: jq runs the filter on each, the stub exits 2 like invalid JSON.
 * The CLI answers every query these blocks pipe to jq with exactly one JSON document, so neither of the
 * last two is reachable from them.
 * The stream filters in STREAMS (#6814, plan-phase step 13) yield zero or more outputs and read empty stdin
 * as no document, as jq does; their pins, a cross-check against real jq where it is on PATH, and a property
 * comparing the two over generated documents, are in tests/plan-phase-coverage-gate.process.test.cjs.
 */

const fs = require('node:fs');

const isFalsy = (v) => v === null || v === undefined || v === false;
const alt = (...candidates) => {
  for (const v of candidates) if (!isFalsy(v)) return v;
  return candidates[candidates.length - 1] === undefined ? null : candidates[candidates.length - 1];
};
const get = (doc, ...keys) => {
  let cur = doc;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : null;
  }
  return cur === undefined ? null : cur;
};

/** filter text -> (document) => output value. Keyed by the exact text the workflows carry. */
const FILTERS = new Map([
  ['(.passed // .data.passed) == true', (d) => alt(get(d, 'passed'), get(d, 'data', 'passed')) === true],
  [
    '(.message // .data.message // "Decision coverage gate failed.")',
    (d) => alt(get(d, 'message'), get(d, 'data', 'message'), 'Decision coverage gate failed.'),
  ],
  // #5221: roadmap.update-plan-progress completion step (executor, execute-plan, execute-phase).
  ['.reason//""', (d) => alt(get(d, 'reason'), '')],
]);

/** A jq runtime error ("Cannot iterate over null"): jq prints it to stderr and exits 5. */
class JqError extends Error {}

/** `.[]` over a value: an array's elements or an object's values; anything else is jq's error. */
const iterate = (v) => {
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === 'object') return Object.values(v);
  throw new JqError(`Cannot iterate over ${v === null ? 'null' : typeof v}`);
};
/** `.key` with jq's strictness (the FILTERS' `get` is lenient; see the known divergences above). */
const field = (d, key) => {
  if (d === null) return null;
  if (typeof d !== 'object' || Array.isArray(d)) throw new JqError(`Cannot index ${Array.isArray(d) ? 'array' : typeof d} with string "${key}"`);
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : null;
};
// jq's `[:space:]` (Oniguruma) is Unicode White_Space: it splits on U+0085 and not on U+FEFF, where JS `\s` does the
// opposite.
const ID_SEPARATOR = /[,\p{White_Space}]+/u;
/** The four characters JSON allows between tokens: stdin made only of them holds no document. */
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/** filter text -> (document) => the outputs, in order. Filters that yield zero or more values. */
const STREAMS = new Map([
  // #6814: plan-phase step 13 lists the live plans, then reads each one's `requirements` (a list or a string);
  // any object, such as frontmatter.get's error answer for a missing key or an unreadable plan, adds nothing.
  ['.plans[]', (d) => iterate(field(d, 'plans'))],
  [
    '(arrays|.[]),.|strings|splits("[,[:space:]]+")|select(.!="")',
    (d) =>
      [...(Array.isArray(d) ? d : []), d]
        .filter((v) => typeof v === 'string')
        .flatMap((s) => s.split(ID_SEPARATOR))
        .filter((s) => s !== ''),
  ],
]);

function main(argv) {
  const flags = new Set();
  let filter = null;
  for (const arg of argv) {
    if (/^-[a-z]+$/.test(arg) && filter === null) for (const ch of arg.slice(1)) flags.add(ch);
    else filter = arg;
  }
  const single = filter === null ? undefined : FILTERS.get(filter);
  const stream = filter === null ? undefined : STREAMS.get(filter);
  if (!single && !stream) {
    process.stderr.write(`jq-subset-stub: unsupported filter ${JSON.stringify(filter)}; add it to FILTERS or STREAMS with jq's semantics\n`);
    return 3;
  }
  if (stream && flags.has('e')) {
    process.stderr.write(`jq-subset-stub: -e is unsupported with the stream filter ${JSON.stringify(filter)}\n`);
    return 3;
  }
  let doc;
  try {
    const text = fs.readFileSync(0, 'utf8');
    if (stream && [...text].every((ch) => JSON_WHITESPACE.has(ch))) return 0;
    doc = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`jq: error (at <stdin>:0): ${err.message}\n`);
    return 2;
  }
  let outs;
  try {
    outs = stream ? stream(doc) : [single(doc)];
  } catch (err) {
    if (!(err instanceof JqError)) throw err;
    process.stderr.write(`jq: error (at <stdin>:0): ${err.message}\n`);
    return 5;
  }
  for (const out of outs) process.stdout.write(`${flags.has('r') && typeof out === 'string' ? out : JSON.stringify(out)}\n`);
  return flags.has('e') && isFalsy(outs[0]) ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, FILTERS, STREAMS };
