#!/usr/bin/env node
// Cross-platform test runner — resolves test file globs via Node
// instead of relying on shell expansion (which fails on Windows PowerShell/cmd).
// Propagates NODE_V8_COVERAGE so c8 collects coverage from the child process.
//
// Suite filtering (issue #3597):
//   node scripts/run-tests.cjs                 # default — runs ALL tests (backcompat)
//   node scripts/run-tests.cjs --suite all     # explicit "everything"
//   node scripts/run-tests.cjs --suite unit    # only files with no other suite marker
//   node scripts/run-tests.cjs --suite security    # *.security.test.cjs
//   node scripts/run-tests.cjs --suite integration # *.integration.test.cjs
//   node scripts/run-tests.cjs --suite install     # *.install.test.cjs
//   node scripts/run-tests.cjs --suite slow        # *.slow.test.cjs
//   node scripts/run-tests.cjs --files "a.test.cjs b.test.cjs"
//   node scripts/run-tests.cjs --files-from /tmp/selected-tests.txt
//   node scripts/run-tests.cjs --suite unit --shard 1/3   # shard 1 of 3 (#1212)
//
// Sharding (issue #1212): --shard <i>/<n> runs a deterministic, balanced
// round-robin slice of the SORTED selected file list (file index k → shard
// k % n). i is 1-based (1..n); n >= 1; n=1 is a pure no-op (all files). The
// CI windows full-test lane shards across N parallel runners so per-job
// wall-clock scales as O(total/N) and stops hitting the job time cap. Sharding
// composes with --suite (it slices the post-filter selection) and preserves
// the existing 28K argv chunking WITHIN each shard.
//
// Suite grouping convention: filename suffix marker before `.test.cjs`.
// A file named `foo.security.test.cjs` belongs to the `security` suite.
// A file named `foo.test.cjs` (no marker) belongs to the `unit` suite.
// See docs/TESTING-SUITES.md for full grouping policy.
'use strict';

const { readdirSync } = require('fs');
const { join, basename } = require('path');
const { execFileSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const SUITES = ['all', 'unit', 'integration', 'install', 'security', 'slow'];

// ADR-457 build-at-publish: gsd-core/bin/lib/*.cjs is generated from
// src/*.cts and gitignored, so on a clean checkout (fresh CI, before any build)
// the artifact is absent — yet test files require it. This is the universal
// chokepoint every test path funnels through (test:unit, --files-from, direct
// invocation), so build the artifact here.
//
// Strategy (incremental + re-emit-on-missing, closes both #969 failure modes):
//   1. Run tsc incrementally (fast ~380ms no-op when sources unchanged).
//   2. Verify every src/*.cts (non-.d.cts) maps to a non-empty gsd-core/bin/lib/*.cjs.
//   3. If any expected .cjs is missing or zero-bytes (persistent-mirror scenario:
//      tsc no-ops because tsbuildinfo looks current even though the file was deleted),
//      delete the tsbuildinfo and run tsc ONCE MORE (clean re-emit), then re-verify.
//
// Common case: fast incremental no-op. Stale/deleted-output case: detected by
// the cheap existsSync loop and force-rebuilt. Paths resolve from __dirname so
// it works regardless of GSD_TEST_DIR / temp-dir cwd.
function ensureBuiltArtifacts(overrides = {}) {
  const { existsSync, readdirSync, statSync, unlinkSync } = require('fs');
  const root = overrides.root || join(__dirname, '..');
  const srcDir = overrides.srcDir || join(root, 'src');
  const outDir = overrides.outDir || join(root, 'gsd-core', 'bin', 'lib');
  const tsBuildInfoPath = overrides.tsBuildInfoPath || join(root, 'tsconfig.build.tsbuildinfo');
  const tsconfigPath = overrides.tsconfigPath || join(root, 'tsconfig.build.json');
  const tscBin = require.resolve('typescript/bin/tsc');
  const tscArgs = [tscBin, '-p', tsconfigPath];

  // Build the 1:1 map of expected output paths from src/*.cts sources.
  // Excludes *.d.cts (declaration-only files that produce no output).
  // Handles subdirectories (e.g. src/installer-migrations/*.cts → gsd-core/bin/lib/installer-migrations/*.cjs).
  function gatherExpectedOutputs() {
    const expected = [];
    function scan(dir, relBase) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          scan(join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith('.cts') && !entry.name.endsWith('.d.cts')) {
          const stem = entry.name.slice(0, -'.cts'.length);
          const rel = relBase ? `${relBase}/${stem}.cjs` : `${stem}.cjs`;
          expected.push(join(outDir, rel));
        }
      }
    }
    scan(srcDir, '');
    return expected;
  }

  function checkMissingOutputs(expectedPaths) {
    return expectedPaths.filter(p => !existsSync(p) || statSync(p).size === 0);
  }

  // #996 placed the tsbuildinfo inside gsd-core/bin/ (a copied/shipped tree), which
  // raced install-test copies. It now lives at the repo root. Best-effort purge any
  // stale bin-local copy so persistent workspaces/mirrors self-heal (no-op on a temp
  // override root or a clean checkout).
  const legacyTsBuildInfo = join(root, 'gsd-core', 'bin', 'tsconfig.build.tsbuildinfo');
  try { if (existsSync(legacyTsBuildInfo)) unlinkSync(legacyTsBuildInfo); } catch { /* best-effort */ }

  // Step 1: incremental build (fast no-op when sources unchanged).
  execFileSync(process.execPath, tscArgs, { cwd: root, stdio: 'inherit' });

  // Step 2: verify expected outputs.
  const expected = gatherExpectedOutputs();
  const missing = checkMissingOutputs(expected);

  // Step 3: if any output is missing/zero-bytes, force a clean re-emit.
  // This handles the persistent-mirror case where tsc's incremental no-op left
  // a deleted .cjs unregenerated (tsbuildinfo recorded it as up-to-date).
  if (missing.length > 0) {
    if (existsSync(tsBuildInfoPath)) {
      unlinkSync(tsBuildInfoPath);
    }
    execFileSync(process.execPath, tscArgs, { cwd: root, stdio: 'inherit' });
    // Re-verify after clean re-emit; surface any remaining gaps loudly.
    const stillMissing = checkMissingOutputs(expected);
    if (stillMissing.length > 0) {
      const names = stillMissing.map(p => require('path').basename(p)).join(', ');
      throw new Error(
        `ensureBuiltArtifacts: tsc clean re-emit still missing outputs: ${names}. ` +
        `Check src/ for compilation errors.`
      );
    }
  }
}
const MARKED_SUITES = ['integration', 'install', 'security', 'slow'];

// Recursively collect *.test.cjs files under dir, returning paths relative to dir.
// Skips node_modules to avoid accidentally picking up decoy files.
function walkTestFiles(dir, relBase) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...walkTestFiles(join(dir, entry.name), relBase ? `${relBase}/${entry.name}` : entry.name));
    } else if (entry.name.endsWith('.test.cjs')) {
      results.push(relBase ? `${relBase}/${entry.name}` : entry.name);
    }
  }
  return results;
}

// Parse a `--shard i/n` value into { index, total } or { error }.
// i is 1-based and must satisfy 1 <= i <= n; n must be >= 1. Both parts must be
// plain non-negative integers (no decimals, signs, or surrounding whitespace).
// `n=1` is the pure no-op (every file). This is the strict-input boundary
// (Postel's Law: be strict in what a CLI flag accepts so a typo fails loudly
// rather than silently running the wrong slice of the suite).
function parseShardArg(value) {
  if (typeof value !== 'string') {
    return { error: `--shard requires a value of the form i/n` };
  }
  const m = /^(\d+)\/(\d+)$/.exec(value);
  if (!m) {
    return { error: `--shard value "${value}" must be of the form i/n (e.g. 1/3)` };
  }
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(total) || total < 1) {
    return { error: `--shard total n must be an integer >= 1, got "${m[2]}"` };
  }
  if (!Number.isInteger(index) || index < 1 || index > total) {
    return { error: `--shard index i must be an integer in 1..${total}, got "${m[1]}"` };
  }
  return { index, total };
}

// Deterministic, balanced round-robin partition of an ALREADY-SORTED file list.
// Shard `index` (1-based) receives every file whose position k in the sorted
// list satisfies k % total === index - 1. Round-robin (not contiguous blocks)
// spreads duration variance across shards and guarantees shard sizes differ by
// at most 1. Selection keys off array INDEX, never off the path string, so the
// partition is byte-identical across Windows/macOS/Linux as long as the caller
// sorts the list with the same (locale-independent) comparator. `total=1`
// returns the input unchanged (pure no-op). A shard with no files (total >
// file count) returns [] and is a legitimate result, not an error.
function selectShard(sortedFiles, { index, total }) {
  if (total === 1) return sortedFiles;
  return sortedFiles.filter((_, k) => k % total === index - 1);
}

function parseArgs(argv) {
  let suite = null;
  let seen = false;
  let files = null;
  let filesFrom = null;
  let shard = null;
  let shardSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shard' || a.startsWith('--shard=')) {
      if (shardSeen) {
        return { error: 'duplicate --shard flag' };
      }
      shardSeen = true;
      let v;
      if (a === '--shard') {
        v = argv[i + 1];
        if (v === undefined || (typeof v === 'string' && v.startsWith('--'))) {
          return { error: '--shard requires a value of the form i/n' };
        }
        i++;
      } else {
        v = a.slice('--shard='.length);
      }
      const parsed = parseShardArg(v);
      if (parsed.error) {
        return { error: parsed.error };
      }
      shard = parsed;
    } else if (a === '--suite') {
      if (seen) {
        return { error: 'duplicate --suite flag' };
      }
      seen = true;
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        return { error: '--suite requires a value' };
      }
      suite = v;
      i++;
    } else if (a.startsWith('--suite=')) {
      if (seen) {
        return { error: 'duplicate --suite flag' };
      }
      seen = true;
      suite = a.slice('--suite='.length);
      if (!suite) {
        return { error: '--suite requires a value' };
      }
    } else if (a === '--files') {
      if (files !== null) {
        return { error: 'duplicate --files flag' };
      }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        return { error: '--files requires a value' };
      }
      files = v;
      i++;
    } else if (a.startsWith('--files=')) {
      if (files !== null) {
        return { error: 'duplicate --files flag' };
      }
      files = a.slice('--files='.length);
      if (!files) {
        return { error: '--files requires a value' };
      }
    } else if (a === '--files-from') {
      if (filesFrom !== null) {
        return { error: 'duplicate --files-from flag' };
      }
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) {
        return { error: '--files-from requires a value' };
      }
      filesFrom = v;
      i++;
    } else if (a.startsWith('--files-from=')) {
      if (filesFrom !== null) {
        return { error: 'duplicate --files-from flag' };
      }
      filesFrom = a.slice('--files-from='.length);
      if (!filesFrom) {
        return { error: '--files-from requires a value' };
      }
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  if (files !== null && filesFrom !== null) {
    return { error: '--files and --files-from cannot be combined' };
  }
  return { suite, files, filesFrom, shard };
}

// Return the marked suite name embedded in a filename, or null if it's unmarked.
// foo.security.test.cjs -> "security"
// foo.test.cjs          -> null (unit)
// Accepts either a bare filename or a relative subdir path; classification is
// based on the basename only so subdir paths classify identically to root files.
function suiteOf(filename) {
  const name = basename(filename);
  if (!name.endsWith('.test.cjs')) return null;
  const base = name.slice(0, -'.test.cjs'.length);
  const lastDot = base.lastIndexOf('.');
  if (lastDot === -1) return null;
  const marker = base.slice(lastDot + 1);
  return MARKED_SUITES.includes(marker) ? marker : null;
}

function selectFiles(allFiles, suite) {
  if (suite === null || suite === 'all') {
    return allFiles;
  }
  if (suite === 'unit') {
    return allFiles.filter(f => suiteOf(f) === null);
  }
  return allFiles.filter(f => suiteOf(f) === suite);
}

function splitFileList(value) {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.replace(/\\/g, '/'))   // normalize Windows backslashes
    .map(v => v.replace(/^tests\//, ''));
}

function selectExplicitFiles(allFiles, filesValue, filesFrom) {
  const fs = require('fs');
  const requested = filesFrom
    ? splitFileList(fs.readFileSync(filesFrom, 'utf8'))
    : splitFileList(filesValue);
  const available = new Set(allFiles);

  // Build a basename -> [relpath, ...] index for bare-basename resolution.
  // A bare basename (no directory separator) may match exactly one subdir file.
  const basenameIndex = new Map();
  for (const f of allFiles) {
    const b = basename(f);
    if (!basenameIndex.has(b)) basenameIndex.set(b, []);
    basenameIndex.get(b).push(f);
  }

  const selected = [];
  const missing = [];
  const errors = [];
  for (const file of requested) {
    // If the token is a bare suite name (e.g. "unit" written by ci-test-scope
    // as the #408 fallback sentinel), delegate to the existing suite resolver
    // rather than treating it as a filename. This prevents the
    // "requested test file(s) not found: unit" crash (#641).
    if (SUITES.includes(file)) {
      for (const f of selectFiles(allFiles, file)) {
        selected.push(f);
      }
    } else if (available.has(file)) {
      // Exact relpath match (e.g. "installer-migrations/001-legacy-orphan-files.test.cjs").
      selected.push(file);
    } else if (!file.includes('/')) {
      // Bare basename (no directory separator): resolve via index.
      const candidates = basenameIndex.get(file);
      if (!candidates || candidates.length === 0) {
        missing.push(file);
      } else if (candidates.length > 1) {
        errors.push(
          `ambiguous basename "${file}" matches multiple files: ${candidates.join(', ')} — pass the subdir path instead`,
        );
      } else {
        selected.push(candidates[0]);
      }
    } else {
      missing.push(file);
    }
  }
  if (errors.length > 0) {
    return { error: errors.join('; ') };
  }
  if (missing.length > 0) {
    return {
      error: `requested test file(s) not found: ${missing.join(', ')}`,
    };
  }
  return { files: [...new Set(selected)] };
}

function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(`run-tests: ${parsed.error}`);
    console.error(`Valid suites: ${SUITES.join(', ')}`);
    throw new ExitError(2);
  }
  const suite = parsed.suite;
  if (suite !== null && !SUITES.includes(suite)) {
    console.error(`run-tests: unknown suite "${suite}"`);
    console.error(`Valid suites: ${SUITES.join(', ')}`);
    throw new ExitError(2);
  }

  const testDir = process.env.GSD_TEST_DIR
    ? process.env.GSD_TEST_DIR
    : join(__dirname, '..', 'tests');

  const allFiles = walkTestFiles(testDir, '').sort();

  if (allFiles.length === 0) {
    console.error(`No test files found in ${testDir}`);
    throw new ExitError(1);
  }

  const usingExplicitFiles = parsed.files !== null || parsed.filesFrom !== null;
  let selectedNames;
  if (usingExplicitFiles) {
    const explicit = selectExplicitFiles(allFiles, parsed.files, parsed.filesFrom);
    if (explicit.error) {
      console.error(`run-tests: ${explicit.error}`);
      throw new ExitError(2);
    }
    selectedNames = explicit.files;
  } else {
    selectedNames = selectFiles(allFiles, suite);
  }

  // Shard partitioning (#1212): when --shard i/n is given, keep only this
  // shard's deterministic round-robin slice of the selected list. Applied
  // AFTER suite/explicit selection so it composes with --suite (each shard
  // runs i/n of the post-filter selection).
  //
  // The partition keys off array index, so the slice is only reproducible if
  // the input is in a stable order. --suite/default selections are already
  // sorted (allFiles came from walkTestFiles(...).sort() and selectFiles
  // preserves that order), but --files/--files-from preserve REQUEST order.
  // Sort here so --shard is deterministic regardless of how the selection was
  // produced — the runner's documented contract is a sorted partition.
  //
  // emptyBeforeShard distinguishes "this shard legitimately got zero files
  // from a non-empty list" (total > file count — a valid no-op) from "the
  // selection was already empty before sharding" (a genuinely empty suite,
  // which must still hit the discovery hard-error below — Codex #1212 review).
  const usingShard = parsed.shard !== null;
  let emptyBeforeShard = false;
  if (usingShard) {
    emptyBeforeShard = selectedNames.length === 0;
    selectedNames = selectShard([...selectedNames].sort(), parsed.shard);
  }

  const selected = selectedNames.map(f => join(testDir, f));

  if (selected.length === 0) {
    // A legitimately-empty shard: --shard was given, the pre-shard selection
    // had files, but this shard index drew zero (total > file count). Exit 0.
    const legitimatelyEmptyShard = usingShard && !emptyBeforeShard;
    if (usingExplicitFiles || legitimatelyEmptyShard) {
      // Empty file list from --files/--files-from (e.g. CI passes an empty
      // .ci-selected-tests.txt on docs-only/inert PRs) OR a legitimately-empty
      // shard: both are expected. Exit 0 silently rather than taking the
      // "discovery broken" hard-error path below. An EMPTY suite that was
      // empty BEFORE sharding falls through to the hard error so a broken
      // --suite filter is still caught even with --shard present.
      console.error(`run-tests: no tests in suite "${suite || 'all'}"`);
      return 0;
    }
    // Empty suite/default run: this means discovery or the suite filter is broken.
    // Allow GSD_ALLOW_EMPTY_SUITE=1 as an escape hatch (downgrades to a warning).
    if (process.env.GSD_ALLOW_EMPTY_SUITE === '1') {
      console.error(`run-tests: WARNING: 0 test files selected for suite "${suite || 'all'}" — discovery or suite filter may be broken (GSD_ALLOW_EMPTY_SUITE=1 suppressed the error)`);
      return 0;
    }
    console.error(`run-tests: ERROR: 0 test files selected for suite "${suite || 'all'}" — discovery or suite filter is broken`);
    throw new ExitError(1);
  }

  // Build the gitignored bin/lib artifact if absent, before any test requires it.
  ensureBuiltArtifacts();

  // Hermeticity: in-process tests resolve `.planning` via planningDir(cwd), which
  // honours GSD_PROJECT/GSD_WORKSTREAM. A developer shell inside a GSD workstream
  // exports GSD_WORKSTREAM, which would redirect fixture STATE.md reads away from
  // each <tmp>/.planning and silently diverge from the clean CI/Docker env. Strip
  // them so the local runner matches CI; tests that need them set them explicitly.
  delete process.env.GSD_PROJECT;
  delete process.env.GSD_WORKSTREAM;
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  // Log selected files to stderr for CI / harness-test visibility.
  // node:test default reporter doesn't echo filenames, so this gives
  // operators a single stable line they can grep.
  console.error(
    `run-tests: suite="${suite || 'all'}" files=${selected.length}: ${selected
      .map(f => f.split(/[\\/]/).pop())
      .join(' ')}`,
  );

  // Default concurrency: 4 on Linux/macOS, 2 on Windows.
  //
  // Windows has significantly higher per-subprocess overhead than Linux/macOS:
  //   - Windows Defender scans each spawned process on first execution, adding
  //     latency proportional to the number of concurrent spawns.
  //   - NTFS has higher file-system latency under concurrent access compared to
  //     ext4/APFS, which amplifies contention when multiple test chunks run in
  //     parallel and all read/write the same fixture directories.
  // Reducing to 2 halves the peak concurrent subprocess count on Windows and
  // keeps per-chunk wall-clock time well within the 20m CI job cap.
  //
  // Operator override via TEST_CONCURRENCY env var for local debugging.
  const defaultConcurrency = process.platform === 'win32' ? 2 : 4;
  const concurrency = process.env.TEST_CONCURRENCY
    ? `--test-concurrency=${process.env.TEST_CONCURRENCY}`
    : `--test-concurrency=${defaultConcurrency}`;

  // Windows `CreateProcess` caps the full command line at 32,767 chars
  // (lpCommandLine). With 500+ test paths the spawn fails instantly with no
  // test output. Linux/macOS allow ~2 MB (ARG_MAX) so unchunked spawns are
  // fine there. Split into chunks sized for the tightest target so behavior
  // is identical across platforms. (#3597)
  // Operator override (also used by tests to force chunking with short paths).
  const MAX_CMDLINE_CHARS = process.env.RUN_TESTS_MAX_CMDLINE_CHARS
    ? Number(process.env.RUN_TESTS_MAX_CMDLINE_CHARS)
    : 28000; // headroom below the 32,767 Windows ceiling
  const MAX_FILES_PER_CHUNK = process.env.RUN_TESTS_MAX_FILES_PER_CHUNK
    ? Number(process.env.RUN_TESTS_MAX_FILES_PER_CHUNK)
    : 180;

  // node:test does not exit until the event loop drains. A unit test that leaks
  // an open handle (un-terminated Worker, un-killed child_process, ref'd timer)
  // makes a chunk's `node --test` child hang ~150s on Windows AFTER its last test
  // prints; two such stalls push the windows full lane past its 20m cap and the
  // job is CANCELLED with no failed step — a false-negative gate (#1051, recurrence
  // of #869). --test-force-exit (Node >=22; engines requires >=22.0.0) exits the
  // runner once all tests finish regardless of lingering handles. The leaking
  // tests are also fixed at the source; this is the defensive backstop.
  // RUN_TESTS_NO_FORCE_EXIT=1 disables it (used by the harness regression test to
  // observe the pre-fix hang).
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const forceExit = nodeMajor >= 22 && !process.env.RUN_TESTS_NO_FORCE_EXIT;

  const FIXED_OVERHEAD = process.execPath.length + '--test'.length + concurrency.length + (forceExit ? '--test-force-exit'.length + 1 : 0) + 8;
  const chunks = [];
  let current = [];
  let currentLen = FIXED_OVERHEAD;
  for (const file of selected) {
    const add = file.length + 1; // +1 for the inter-arg separator
    if (
      current.length > 0 &&
      (currentLen + add > MAX_CMDLINE_CHARS || current.length >= MAX_FILES_PER_CHUNK)
    ) {
      chunks.push(current);
      current = [];
      currentLen = FIXED_OVERHEAD;
    }
    current.push(file);
    currentLen += add;
  }
  if (current.length > 0) chunks.push(current);

  // A chunk that still hangs (a leak the backstop somehow misses, or a wedged
  // subprocess) must fail loudly rather than silently burn the job's wall-clock
  // budget until the CI runner cancels the whole job. Default 10 min per chunk:
  // well above a healthy chunk (~4-5 min on the windows lane) but below the 20m
  // job cap. Operator/test override via RUN_TESTS_CHUNK_TIMEOUT_MS.
  const chunkTimeoutMs = process.env.RUN_TESTS_CHUNK_TIMEOUT_MS
    ? Number(process.env.RUN_TESTS_CHUNK_TIMEOUT_MS)
    : 600000;

  let firstFailureExit = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      console.error(`run-tests: chunk ${i + 1}/${chunks.length} — ${chunks[i].length} files`);
    }
    try {
      execFileSync(
        process.execPath,
        ['--test', ...(forceExit ? ['--test-force-exit'] : []), concurrency, ...chunks[i]],
        {
          stdio: 'inherit',
          env: { ...process.env },
          timeout: chunkTimeoutMs,
        },
      );
    } catch (err) {
      // When the per-chunk timeout fires, execFileSync kills the child and
      // surfaces it as err.code === 'ETIMEDOUT' (POSIX) and/or err.killed === true
      // (platform-dependent). Check both so detection holds on Windows and POSIX.
      const timedOut = err.killed === true || err.code === 'ETIMEDOUT';
      if (timedOut) {
        console.error(
          `run-tests: chunk ${i + 1}/${chunks.length} exceeded the per-chunk timeout ` +
            `of ${chunkTimeoutMs}ms and was killed — a test in this chunk is likely leaking ` +
            `an open handle (un-terminated Worker, un-killed child process, or ref'd timer) ` +
            `so node --test never exits. Files: ${chunks[i]
              .map(f => f.split(/[\\/]/).pop())
              .join(' ')}`,
        );
      }
      const code = err.status || 1;
      // Run every chunk so the operator sees all failures in one pass; report
      // the first non-zero exit at the end.
      if (firstFailureExit === 0) firstFailureExit = code;
    }
  }
  if (firstFailureExit !== 0) return firstFailureExit;
}

if (require.main === module) {
  runMain(main);
}

module.exports = { suiteOf, ensureBuiltArtifacts, parseShardArg, selectShard };
