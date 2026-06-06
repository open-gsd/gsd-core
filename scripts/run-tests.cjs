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
//
// Suite grouping convention: filename suffix marker before `.test.cjs`.
// A file named `foo.security.test.cjs` belongs to the `security` suite.
// A file named `foo.test.cjs` (no marker) belongs to the `unit` suite.
// See docs/TESTING-SUITES.md for full grouping policy.
'use strict';

const { readdirSync, existsSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const SUITES = ['all', 'unit', 'integration', 'install', 'security', 'slow'];

// ADR-457 build-at-publish: gsd-core/bin/lib/*.cjs is generated from
// src/*.cts and gitignored, so on a clean checkout (fresh CI, before any build)
// the artifact is absent — yet test files require it. This is the universal
// chokepoint every test path funnels through (test:unit, --files-from, direct
// invocation), so build the artifact here if missing. It is a no-op once built
// (dev, pretest, a prior run in the same job), which keeps the harness test's
// spawned invocations side-effect-free. Paths resolve from __dirname (not cwd),
// so it works regardless of GSD_TEST_DIR / temp-dir cwd. NOTE: the sentinel is
// the pilot module; revisit (or switch to an unconditional quiet build) as more
// modules migrate into src/.
function ensureBuiltArtifacts() {
  const root = join(__dirname, '..');
  const sentinel = join(root, 'gsd-core', 'bin', 'lib', 'semver-compare.cjs');
  if (existsSync(sentinel)) return;
  const tscBin = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscBin, '-p', join(root, 'tsconfig.build.json')], {
    cwd: root,
    stdio: 'inherit',
  });
}
const MARKED_SUITES = ['integration', 'install', 'security', 'slow'];

function parseArgs(argv) {
  let suite = null;
  let seen = false;
  let files = null;
  let filesFrom = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') {
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
  return { suite, files, filesFrom };
}

// Return the marked suite name embedded in a filename, or null if it's unmarked.
// foo.security.test.cjs -> "security"
// foo.test.cjs          -> null (unit)
function suiteOf(filename) {
  if (!filename.endsWith('.test.cjs')) return null;
  const base = filename.slice(0, -'.test.cjs'.length);
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
    .map(v => v.replace(/^tests[\\/]/, ''));
}

function selectExplicitFiles(allFiles, filesValue, filesFrom) {
  const fs = require('fs');
  const requested = filesFrom
    ? splitFileList(fs.readFileSync(filesFrom, 'utf8'))
    : splitFileList(filesValue);
  const available = new Set(allFiles);
  const selected = [];
  const missing = [];
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
      selected.push(file);
    } else {
      missing.push(file);
    }
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

  const allFiles = readdirSync(testDir)
    .filter(f => f.endsWith('.test.cjs'))
    .sort();

  if (allFiles.length === 0) {
    console.error(`No test files found in ${testDir}`);
    throw new ExitError(1);
  }

  let selectedNames;
  if (parsed.files !== null || parsed.filesFrom !== null) {
    const explicit = selectExplicitFiles(allFiles, parsed.files, parsed.filesFrom);
    if (explicit.error) {
      console.error(`run-tests: ${explicit.error}`);
      throw new ExitError(2);
    }
    selectedNames = explicit.files;
  } else {
    selectedNames = selectFiles(allFiles, suite);
  }
  const selected = selectedNames.map(f => join(testDir, f));

  if (selected.length === 0) {
    // Empty suite: report and exit 0 so empty lanes (e.g. `security` before
    // adversarial tests land) don't gate CI. CI consumers wanting strictness
    // can grep stderr for "no tests in suite".
    console.error(`run-tests: no tests in suite "${suite || 'all'}"`);
    return 0;
  }

  // Build the gitignored bin/lib artifact if absent, before any test requires it.
  ensureBuiltArtifacts();

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
  //   - Windows Defender scans each spawned process
  //   - NTFS has higher file-system latency under concurrent access
  //   - synckit worker_threads (used by the SDK bridge in gsd-tools.cjs) spawn
  //     native threads that contend on SharedArrayBuffer + Atomics.wait; under
  //     Node 24 on Windows, 4-way concurrent gsd-tools invocations (each spawning
  //     a synckit worker) caused intermittent process crashes with empty stderr —
  //     a signature of OS-level resource exhaustion killing worker threads before
  //     they could flush. Reducing to 2 halves the peak concurrent worker count.
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
  const FIXED_OVERHEAD = process.execPath.length + '--test'.length + concurrency.length + 8;
  const chunks = [];
  let current = [];
  let currentLen = FIXED_OVERHEAD;
  for (const file of selected) {
    const add = file.length + 1; // +1 for the inter-arg separator
    if (current.length > 0 && currentLen + add > MAX_CMDLINE_CHARS) {
      chunks.push(current);
      current = [];
      currentLen = FIXED_OVERHEAD;
    }
    current.push(file);
    currentLen += add;
  }
  if (current.length > 0) chunks.push(current);

  let firstFailureExit = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      console.error(`run-tests: chunk ${i + 1}/${chunks.length} — ${chunks[i].length} files`);
    }
    try {
      execFileSync(process.execPath, ['--test', concurrency, ...chunks[i]], {
        stdio: 'inherit',
        env: { ...process.env },
      });
    } catch (err) {
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

module.exports = { suiteOf };
