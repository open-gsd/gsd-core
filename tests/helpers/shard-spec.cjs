'use strict';

/**
 * Shared helper for the `i/n` shard specs that workflow matrices declare (#5029).
 *
 * Three test files read the Windows conformance layout from test.yml and a
 * fourth reads release.yml's, and they kept their own parsers: a `split('/')` in
 * two, a copy of the --shard grammar in the other two. This is the one reader.
 * parseShardSpec delegates to parseShardArg in scripts/run-tests.cjs, so a spec
 * these tests accept is exactly a spec the runner accepts.
 */

const assert = require('node:assert/strict');
const { parseShardArg } = require('../../scripts/run-tests.cjs');

/** Parse an `i/n` shard spec into { index, total }, or null if malformed. */
function parseShardSpec(spec) {
  const parsed = parseShardArg(spec);
  return parsed.error ? null : parsed;
}

/** True iff `specs` is exactly one complete shard set: same N, numerators 1..N. */
function isCompleteShardSet(specs) {
  if (specs.length === 0) return false;
  const parsed = specs.map(parseShardSpec);
  if (parsed.some((p) => p === null)) return false;
  const total = parsed[0].total;
  if (parsed.some((p) => p.total !== total)) return false;
  if (parsed.length !== total) return false;
  const seen = new Set(parsed.map((p) => p.index));
  return seen.size === total && [...seen].every((i) => i >= 1 && i <= total);
}

/**
 * The shard total test.yml's windows-latest conformance rows declare. Throws
 * unless every row carries a valid spec and all of them agree on one total.
 */
function declaredWindowsConformanceShards(workflow) {
  const entries = workflow.jobs['test-conformance'].strategy.matrix.include
    .filter((e) => e.os === 'windows-latest');
  const parsed = entries.map((e) => parseShardSpec(e.shard));
  assert.ok(
    parsed.length > 0 && parsed.every((p) => p !== null),
    `windows conformance entries must each declare an i/n shard: ${JSON.stringify(entries)}`,
  );
  const totals = [...new Set(parsed.map((p) => p.total))];
  assert.equal(totals.length, 1, `windows conformance entries disagree on the shard total: ${JSON.stringify(entries)}`);
  return totals[0];
}

module.exports = {
  parseShardSpec,
  isCompleteShardSet,
  declaredWindowsConformanceShards,
};
