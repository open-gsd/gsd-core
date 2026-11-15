#!/usr/bin/env node
'use strict';

/**
 * Compacts one CI shard's raw V8 coverage dumps into a single merged file.
 *
 * Why: the `coverage-gate` job used to download every shard's raw dumps
 * (~1.68 GB across 3 shards, mostly node internals, tests/ and
 * node_modules scripts that c8 discards at report time) and make
 * `c8 report --merge-async` parse and merge all of it twice (lib report +
 * scripts floor). Doing the same filter + merge on each shard, in parallel
 * with the other shards, leaves the gate three small files to merge.
 *
 * Exactness: this applies the SAME steps c8's Report applies before it
 * converts to istanbul — `_normalizeProcessCov` (node: urls, file:// urls,
 * include/exclude filter), `_normalizeSourceMapCache` (file-url keys; a
 * non-file key throws, as it does in c8) and then `@bcoe/v8-coverage`
 * `mergeProcessCovs`. Merging is applied in batches of MERGE_BATCH_SIZE
 * (`mergeProcessCovs([acc, ...batch])`) so peak memory does not grow with the
 * number of dumps (#6140). Merge grouping preserves every per-offset execution
 * count (what line/statement coverage reads), but @bcoe/v8-coverage
 * normalization is not associative in range structure: a block range can be
 * wrapped or joined differently than in a one-pass merge, so istanbul branch
 * totals may differ by merge grouping, the same variance the shard -> gate
 * merge already has (pinned by test). The merged output is a valid c8
 * temp-directory dump, so the gate's unchanged
 * `c8 report` commands read it as if it were one more raw dump. Retained urls
 * are the UNION of every include glob the gate uses, so both
 * `test:coverage:report` and `test:coverage:scripts-floor` see all of the
 * data they would have seen before. The one deliberate deviation from raw c8
 * is `normalizeBlockFlags`, which makes a never-called function's block flag
 * independent of dump count (#5985).
 *
 * Guard: a shard that produced no V8 coverage dumps at all throws, restoring
 * the `if-no-files-found: error` guarantee the raw-dump upload step gave.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { fileURLToPath, pathToFileURL } = require('url');

// Single source of truth for what the gate may report on. Must stay equal to
// the union of the --include globs in package.json's test:coverage:report and
// test:coverage:scripts-floor (tests/ci-compact-v8-coverage.test.cjs pins it).
const INCLUDE_GLOBS = ['gsd-core/bin/lib/**/*.cjs', 'scripts/**/*.cjs'];
const EXCLUDE_GLOBS = ['tests/**'];
// Bounds how many filtered dumps are held before folding them into the accumulator (#6140).
const MERGE_BATCH_SIZE = 64;

function loadDeps(cwd) {
  // Resolve through c8 so the versions are exactly the ones c8 itself uses.
  const c8Require = createRequire(require.resolve('c8/package.json', { paths: [cwd, __dirname] }));
  return {
    mergeProcessCovs: c8Require('@bcoe/v8-coverage').mergeProcessCovs,
    Exclude: c8Require('test-exclude'),
  };
}

// Normalized href for a retained script url, or null when c8 would discard it.
function retainedHref(shouldInstrument, url) {
  if (typeof url !== 'string' || !/^file:\/\//.test(url)) return null; // node: and non-file urls
  const filePath = fileURLToPath(url);
  return shouldInstrument(filePath) ? pathToFileURL(filePath).href : null;
}

// The same rule @bcoe/v8-coverage mergeFunctionCovs applies on a real merge
// (merge.js:158). Its single-input fast path skips it, so under c8's pairwise
// merge a never-called function adds a 0-count branch only when it appears in
// an odd number of dumps. Applying the rule unconditionally makes the gate's
// branch count independent of how dumps are split into shards (#5985).
function normalizeBlockFlags(result) {
  for (const script of result) {
    for (const fn of script.functions) {
      if (fn.ranges.length === 1 && fn.ranges[0].count === 0) fn.isBlockCoverage = false;
    }
  }
}

// `mergeProcessCovs` is an injection point for tests; main() never passes it.
function compact({ tempDirectory, outFile, cwd = process.cwd(), batchSize = MERGE_BATCH_SIZE, mergeProcessCovs: mergeOverride }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`ci-compact-v8-coverage: batchSize must be a positive integer, got ${batchSize}`);
  }
  const deps = loadDeps(cwd);
  const mergeProcessCovs = mergeOverride || deps.mergeProcessCovs;
  const { Exclude } = deps;
  const exclude = new Exclude({
    cwd,
    include: INCLUDE_GLOBS,
    // Exactly c8's set: an explicit --exclude REPLACES istanbul's default exclude
    // (c8 lib/parse-args.js `exclude` default), so defaultExclude must not apply.
    exclude: [...EXCLUDE_GLOBS],
    relativePath: true,
    excludeNodeModules: true,
  });

  // Memoized per path, as c8 does (report.js shouldInstrumentCache): the same
  // node_modules scripts repeat across every dump.
  const instrumentCache = new Map();
  const shouldInstrument = (filePath) => {
    let decision = instrumentCache.get(filePath);
    if (decision === undefined) {
      decision = exclude.shouldInstrument(filePath);
      instrumentCache.set(filePath, decision);
    }
    return decision;
  };
  const hrefCache = new Map();
  const hrefFor = (url) => {
    if (typeof url !== 'string') return null;
    let href = hrefCache.get(url);
    if (href === undefined) {
      href = retainedHref(shouldInstrument, url);
      hrefCache.set(url, href);
    }
    return href;
  };

  let merged = null;
  let pending = [];
  // Count equality across merge groupings relies on a V8 invariant: detailed
  // (NODE_V8_COVERAGE) coverage reports isBlockCoverage:false only for a
  // never-compiled function (one range, count 0). @bcoe/v8-coverage drops
  // function-level entries when block-level ones exist, so a function-level
  // entry with count > 0 would merge differently by grouping.
  const flush = () => {
    if (pending.length === 0) return;
    merged = mergeProcessCovs(merged ? [merged, ...pending] : pending);
    pending = [];
  };
  const sourceMapCache = {};
  let inputFiles = 0;
  for (const name of fs.readdirSync(tempDirectory).sort()) {
    let dump;
    try {
      dump = JSON.parse(fs.readFileSync(path.join(tempDirectory, name), 'utf8'));
    } catch {
      continue; // c8 skips unparsable dumps too
    }
    if (!dump || !Array.isArray(dump.result)) continue;
    inputFiles++;
    const result = [];
    for (const script of dump.result) {
      const href = hrefFor(script.url);
      if (href === null) continue;
      script.url = href;
      result.push(script);
    }
    const cache = dump['source-map-cache'];
    if (cache) {
      for (const key of Object.keys(cache)) {
        // c8's _normalizeSourceMapCache calls fileURLToPath(key) unguarded: a
        // non-file key throws there, so it throws here too.
        const keyPath = fileURLToPath(key);
        if (shouldInstrument(keyPath)) sourceMapCache[pathToFileURL(keyPath).href] = cache[key];
      }
    }
    pending.push({ result });
    if (pending.length >= batchSize) flush();
  }

  if (inputFiles === 0) {
    throw new Error(`ci-compact-v8-coverage: no V8 coverage dumps in ${tempDirectory}`);
  }

  flush();
  const out = { result: merged ? merged.result : [], 'source-map-cache': sourceMapCache };
  normalizeBlockFlags(out.result);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out));
  return { inputFiles, scripts: out.result.length };
}

const USAGE = 'usage: ci-compact-v8-coverage.cjs --out <file> [--temp-directory <dir>]';

function parseArgs(argv) {
  // undefined: flag absent; null: flag present without a usable value.
  const value = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
  };
  const outFile = value('--out');
  const tempDirectory = value('--temp-directory');
  if (!outFile || tempDirectory === null) return { error: USAGE };
  return { tempDirectory: tempDirectory === undefined ? path.join('coverage', 'tmp') : tempDirectory, outFile };
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const stats = compact({ tempDirectory: parsed.tempDirectory, outFile: parsed.outFile });
  console.log(`compacted ${stats.inputFiles} dumps -> ${stats.scripts} scripts in ${parsed.outFile}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { compact, parseArgs, main, INCLUDE_GLOBS, EXCLUDE_GLOBS, MERGE_BATCH_SIZE };
