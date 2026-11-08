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
 * include/exclude filter) then `@bcoe/v8-coverage` `mergeProcessCovs`, which
 * is associative. The merged output is a valid c8 temp-directory dump, so the
 * gate's unchanged `c8 report` commands read it as if it were one more raw
 * dump. Retained urls are the UNION of every include glob the gate uses, so
 * both `test:coverage:report` and `test:coverage:scripts-floor` see all of
 * the data they would have seen before.
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

function loadDeps(cwd) {
  // Resolve through c8 so the versions are exactly the ones c8 itself uses.
  const c8Require = createRequire(require.resolve('c8/package.json', { paths: [cwd, __dirname] }));
  return {
    mergeProcessCovs: c8Require('@bcoe/v8-coverage').mergeProcessCovs,
    Exclude: c8Require('test-exclude'),
    defaultExclude: c8Require('@istanbuljs/schema/default-exclude'),
  };
}

function compact({ tempDirectory, outFile, cwd = process.cwd() }) {
  const { mergeProcessCovs, Exclude, defaultExclude } = loadDeps(cwd);
  const exclude = new Exclude({
    cwd,
    include: INCLUDE_GLOBS,
    exclude: [...defaultExclude, ...EXCLUDE_GLOBS],
    relativePath: true,
    excludeNodeModules: true,
  });

  let merged = null;
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
      const url = script.url;
      if (/^node:/.test(url)) continue; // builtins never match an include glob
      if (!/^file:\/\//.test(url)) continue;
      let filePath;
      try {
        filePath = fileURLToPath(url);
      } catch {
        continue;
      }
      if (!exclude.shouldInstrument(filePath)) continue;
      script.url = pathToFileURL(filePath).href;
      result.push(script);
    }
    const cache = dump['source-map-cache'];
    if (cache) {
      for (const key of Object.keys(cache)) {
        try {
          const keyPath = fileURLToPath(key);
          if (exclude.shouldInstrument(keyPath)) sourceMapCache[pathToFileURL(keyPath).href] = cache[key];
        } catch { /* non-file url: c8 would throw/skip as well */ }
      }
    }
    merged = mergeProcessCovs(merged ? [merged, { result }] : [{ result }]);
  }

  const out = { result: merged ? merged.result : [], 'source-map-cache': sourceMapCache };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out));
  return { inputFiles, scripts: out.result.length };
}

function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tempDirectory = get('--temp-directory') || path.join('coverage', 'tmp');
  const outFile = get('--out');
  if (!outFile) {
    console.error('usage: ci-compact-v8-coverage.cjs --out <file> [--temp-directory <dir>]');
    process.exitCode = 2;
    return;
  }
  const stats = compact({ tempDirectory, outFile });
  console.log(`compacted ${stats.inputFiles} dumps -> ${stats.scripts} scripts in ${outFile}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { compact, INCLUDE_GLOBS, EXCLUDE_GLOBS };
