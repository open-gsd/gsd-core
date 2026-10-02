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
 *   jq [-e] [-r] '<filter>'     reads one JSON document on stdin
 *
 * Semantics kept from jq: `//` yields its right side when the left is `false` or `null` (an empty
 * string is truthy); `.a.b` on a document without `a` is `null`; `-e` exits 1 when the last output is
 * `false` or `null`, 0 otherwise; `-r` prints a string without quotes; invalid JSON exits 2.
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
]);

function main(argv) {
  const flags = new Set();
  let filter = null;
  for (const arg of argv) {
    if (/^-[a-z]+$/.test(arg) && filter === null) for (const ch of arg.slice(1)) flags.add(ch);
    else filter = arg;
  }
  const fn = filter === null ? undefined : FILTERS.get(filter);
  if (!fn) {
    process.stderr.write(`jq-subset-stub: unsupported filter ${JSON.stringify(filter)}; add it to FILTERS with jq's semantics\n`);
    return 3;
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`jq: error (at <stdin>:0): ${err.message}\n`);
    return 2;
  }
  const out = fn(doc);
  process.stdout.write(`${flags.has('r') && typeof out === 'string' ? out : JSON.stringify(out)}\n`);
  return flags.has('e') && isFalsy(out) ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, FILTERS };
