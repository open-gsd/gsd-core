'use strict';

const { execFileSync } = require('node:child_process');
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const { suiteOf } = require('./run-tests.cjs');

const CRITICAL_PATHS = [
  '.github/workflows/',
  'package.json',
  'package-lock.json',
  'scripts/run-tests.cjs',
  'scripts/affected-tests-lib.cjs',
  'scripts/run-affected-tests.cjs',
];

// Suites that are push-only. PRs must never select or run these.
const PR_EXCLUDED_SUITES = new Set(['install', 'slow']);

// Suites run on every PR cell when the critical-path fallback fires.
const PR_FULL_SUITES = ['unit', 'integration', 'security'];

// Source trees to walk when building the forward graph (in addition to tests/).
// Relative to repoRoot. We walk these to discover SUT-internal requires so that
// a change to a deep helper propagates through re-export chains to tests.
const SOURCE_TREES = [
  'gsd-core/bin/lib',
  'bin/lib',
  'bin',
  'scripts',
  'commands',
  'hooks',
  'agents',
  'eslint-rules',
];

function toPosixPath(input) {
  return input.split(path.sep).join('/');
}

function parseRelativeSpecifiers(source) {
  const specifiers = [];
  const requireRe = /require\((['"])(.+?)\1\)/g;
  const importFromRe = /from\s+(['"])(.+?)\1/g;
  let match;

  while ((match = requireRe.exec(source)) !== null) {
    specifiers.push(match[2]);
  }
  while ((match = importFromRe.exec(source)) !== null) {
    specifiers.push(match[2]);
  }

  return specifiers.filter(specifier => specifier.startsWith('.'));
}

// Extended candidate list now includes .ts/.cts/.mts/.json as well as the
// standard .js/.cjs/.mjs and index variants.
function resolveRelativeDependency(repoRoot, fromAbs, specifier) {
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.ts`,
    `${base}.cts`,
    `${base}.mts`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.ts'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return toPosixPath(path.relative(repoRoot, candidate));
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Source-file walker
// ---------------------------------------------------------------------------

/**
 * Collect all .cjs / .mjs / .js / .ts / .cts / .mts / .json files under a
 * directory tree, returned as repo-relative POSIX paths.  Silently skips
 * trees that don't exist.
 */
function walkTree(repoRoot, relDir) {
  const absDir = path.join(repoRoot, relDir);
  if (!existsSync(absDir)) return [];

  const results = [];
  const queue = [absDir];

  while (queue.length > 0) {
    const cur = queue.shift();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules
        if (entry.name === 'node_modules') continue;
        queue.push(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json'].includes(ext)) {
          results.push(toPosixPath(path.relative(repoRoot, abs)));
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Forward graph: Map<fileRel, Set<depRel>>
// ---------------------------------------------------------------------------

/**
 * Build a forward dependency graph over test files PLUS source trees.
 * For each file: read, parseRelativeSpecifiers, resolve each specifier.
 * Returns Map<fileRel, Set<depRel>>.
 */
function buildForwardGraph(repoRoot, testFiles) {
  // Collect all files to index: test files + source files
  const sourceFiles = [];
  for (const tree of SOURCE_TREES) {
    for (const f of walkTree(repoRoot, tree)) {
      sourceFiles.push(f);
    }
  }

  const allFiles = [...new Set([...testFiles, ...sourceFiles])];
  const forward = new Map();

  for (const fileRel of allFiles) {
    const absFile = path.join(repoRoot, fileRel);
    let source;
    try {
      source = readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }

    const specs = parseRelativeSpecifiers(source);
    const deps = new Set();

    for (const specifier of specs) {
      const dep = resolveRelativeDependency(repoRoot, absFile, specifier);
      if (dep) deps.add(dep);
    }

    forward.set(fileRel, deps);
  }

  return forward;
}

// ---------------------------------------------------------------------------
// Reverse-transitive index: Map<depRel, Set<testRel>>
// ---------------------------------------------------------------------------

/**
 * Build the TRANSITIVE reverse index: Map<depRel, Set<testRel>>.
 *
 * Algorithm:
 *   1. Build forward graph over all test + source files.
 *   2. Invert to direct reverse edges: Map<depRel, Set<dependentRel>>.
 *   3. For each test file, BFS backwards through all direct reverse edges
 *      to find every ancestor.  Map each ancestor → the test.
 *
 * Cycle safety: visited set per BFS — each node is enqueued at most once.
 *
 * @param {string} repoRoot
 * @param {string[]} testFiles  repo-relative posix paths (e.g. ['tests/foo.test.cjs'])
 * @returns {Map<string, Set<string>>}
 */
function buildTransitiveReverseIndex(repoRoot, testFiles) {
  const forward = buildForwardGraph(repoRoot, testFiles);

  // Build direct reverse edges: dep → Set of files that directly require dep
  const directReverse = new Map();
  for (const [fileRel, deps] of forward) {
    for (const dep of deps) {
      if (!directReverse.has(dep)) directReverse.set(dep, new Set());
      directReverse.get(dep).add(fileRel);
    }
  }

  // For each test file, BFS through direct reverse edges to collect all
  // ancestors, then invert: ancestor → test.
  // We do this test-file-first (not dep-first) so we know which test reached
  // each ancestor.
  const transitiveReverse = new Map();

  for (const testFile of testFiles) {
    // BFS from testFile following reverse edges (files that point TO testFile,
    // then files that point to THOSE files, etc.).
    // We want: "if X changed, would that eventually pull in testFile?"
    // So we walk the FORWARD graph starting from testFile to find all deps,
    // then any of those deps maps back to testFile.

    // Actually simpler: for each test we do a forward BFS to find ALL files
    // the test transitively depends on.  Then we record testFile as a
    // dependent of each of those files.
    const visited = new Set();
    visited.add(testFile);
    const queue = [testFile];

    while (queue.length > 0) {
      const current = queue.shift();
      const deps = forward.get(current);
      if (!deps) continue;
      for (const dep of deps) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        queue.push(dep);
      }
    }

    // Every file in `visited` (except testFile itself) is a transitive dep.
    // Record testFile as a dependent of each.
    for (const dep of visited) {
      if (dep === testFile) continue;
      if (!transitiveReverse.has(dep)) transitiveReverse.set(dep, new Set());
      transitiveReverse.get(dep).add(testFile);
    }
  }

  return transitiveReverse;
}

// ---------------------------------------------------------------------------
// Legacy shim — kept so that runAffectedTests can call buildTransitiveReverseIndex
// and existing call sites that still call buildReverseIndex still work.
// ---------------------------------------------------------------------------
function buildReverseIndex(repoRoot, testFiles) {
  return buildTransitiveReverseIndex(repoRoot, testFiles);
}

function shouldRunFullSuite(changedFiles) {
  return changedFiles.some(file =>
    CRITICAL_PATHS.some(critical => file === critical || file.startsWith(critical)),
  );
}

function listTestFiles(repoRoot) {
  return readdirSync(path.join(repoRoot, 'tests'))
    .filter(file => file.endsWith('.test.cjs'))
    .map(file => `tests/${file}`)
    .sort();
}

/**
 * Select the affected tests given a set of changed files and a reverse index.
 *
 * Options:
 *   detectWiden {boolean} — when true, attach `._widenRequired = true` to the
 *     returned array when a changed source file has zero transitive test
 *     dependents.  The caller (runAffectedTests) uses this to widen to unit/all.
 *
 * The returned array is sorted and may have `._widenRequired` attached.
 */
function pickAffectedTests(changedFiles, allTests, reverseIndex, options = {}) {
  const { detectWiden = false } = options;
  const selected = new Set();
  let widenRequired = false;

  // Build a fast lookup of currently-existing test files (from readdirSync — deleted files absent).
  const allTestsSet = new Set(allTests);

  // (a) directly-changed test files + (b) transitive test dependents
  // Deleted test files are filtered out — they no longer exist and cannot be run.
  // A deleted test file also must NOT trigger widen (the test is simply gone).
  for (const file of changedFiles) {
    if (file.startsWith('tests/') && file.endsWith('.test.cjs')) {
      // Only select if the test file still exists (i.e. is present in allTests from readdirSync).
      if (allTestsSet.has(file)) {
        selected.add(file);
      }
      // Deleted test file — do not add to selected; do not look up reverse index.
    } else {
      const dependents = reverseIndex.get(file);
      if (dependents) {
        for (const testFile of dependents) selected.add(testFile);
      }
    }
  }

  // (c) stem heuristic — kept as secondary mechanism
  for (const file of changedFiles) {
    const stem = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (!stem) continue;
    for (const testFile of allTests) {
      if (testFile.toLowerCase().includes(stem)) selected.add(testFile);
    }
  }

  // Widen backstop: if a changed file is a non-test, non-CRITICAL_PATH source file
  // (recognised extension) under a SOURCE_TREE, AND it is either deleted (no longer
  // on disk — so never in the forward graph and has no static dependents) OR it
  // exists with ZERO transitive test dependents — signal a widen.
  // NOTE: we deliberately do NOT skip deleted files here; a deleted source file's
  // absence from the forward graph means dependents===undefined, which is the same
  // as zero static dependents, and is itself the widen trigger.
  if (detectWiden) {
    for (const file of changedFiles) {
      // Only care about source files, not test files or docs
      if (file.startsWith('tests/')) continue;
      if (shouldRunFullSuite([file])) continue; // critical path already triggers full suite
      // Check: is this a source file (has a recognised extension)?
      const ext = path.extname(file);
      const isSourceFile = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json'].includes(ext);
      if (!isSourceFile) continue;
      // Check: is this file under a recognised source tree?
      const isUnderSourceTree = SOURCE_TREES.some(
        tree => file === tree || file.startsWith(tree + '/'),
      );
      if (!isUnderSourceTree) continue;
      // Does it have any test dependents?
      // A deleted file will have undefined here (not in the graph) — that is
      // treated as zero static dependents and triggers widen conservatively.
      const dependents = reverseIndex.get(file);
      const hasStaticDependents = dependents && dependents.size > 0;
      if (!hasStaticDependents) {
        widenRequired = true;
        break;
      }
    }
  }

  // Drop any file whose suite is push-only. This is the single chokepoint —
  // it catches direct-change, reverse-index, AND stem-match selections.
  for (const file of selected) {
    const suite = suiteOf(path.basename(file));
    if (PR_EXCLUDED_SUITES.has(suite)) selected.delete(file);
  }

  // When nothing maps, return an empty array. The caller decides the fallback.
  const result = [...selected].sort();
  if (widenRequired) result._widenRequired = true;
  return result;
}

function changedFilesSinceBase(repoRoot, baseRef) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '--diff-filter=ACMRD', `${baseRef}...HEAD`],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

function runNodeTestFiles(repoRoot, files) {
  const defaultConcurrency = process.platform === 'win32' ? 2 : 4;
  const concurrency = process.env.TEST_CONCURRENCY
    ? `--test-concurrency=${process.env.TEST_CONCURRENCY}`
    : `--test-concurrency=${defaultConcurrency}`;
  const absoluteFiles = files.map(file => path.join(repoRoot, file));

  // Keep chunks bounded for Windows CreateProcess command-length limits.
  const maxChars = process.env.RUN_TESTS_MAX_CMDLINE_CHARS
    ? Number(process.env.RUN_TESTS_MAX_CMDLINE_CHARS)
    : 28000;
  const fixed = process.execPath.length + '--test'.length + concurrency.length + 8;
  const chunks = [];
  let current = [];
  let currentLen = fixed;

  for (const file of absoluteFiles) {
    const add = file.length + 1;
    if (current.length > 0 && currentLen + add > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = fixed;
    }
    current.push(file);
    currentLen += add;
  }
  if (current.length > 0) chunks.push(current);

  let firstFailure = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      console.error(`affected-tests: chunk ${i + 1}/${chunks.length} (${chunks[i].length} files)`);
    }
    try {
      execFileSync(process.execPath, ['--test', concurrency, ...chunks[i]], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env },
      });
    } catch (error) {
      const code = error.status || 1;
      if (firstFailure === 0) firstFailure = code;
    }
  }
  if (firstFailure !== 0) process.exit(firstFailure);
}

function runSuite(repoRoot, suite) {
  execFileSync(process.execPath, ['scripts/run-tests.cjs', '--suite', suite], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
  });
}

function resolveBaseRef() {
  if (process.env.GSD_AFFECTED_BASE) return process.env.GSD_AFFECTED_BASE;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return 'origin/main';
}

/**
 * Pure function: given the outputs of the selection phase, return a run plan
 * describing what should be executed. No I/O is performed here.
 *
 * Return shapes:
 *   { mode: 'suite',  suite: 'unit' }           — no changed files
 *   { mode: 'suites', suites: PR_FULL_SUITES }  — critical path triggered
 *   { mode: 'suites', suites: PR_FULL_SUITES }  — widen required (orphan src file)
 *   { mode: 'suite',  suite: 'unit' }           — selection empty after widen=false
 *   { mode: 'files',  files: string[] }         — concrete selection, no widen
 *
 * Invariant: when widenRequired is true the executed set is ALWAYS ⊇ selected,
 * because PR_FULL_SUITES covers every PR-eligible suite (unit + integration +
 * security), so every concrete match that pickAffectedTests put into `selected`
 * belongs to one of those suites and will be exercised by running all three.
 */
function resolveRunPlan({ changedFiles, selected, widenRequired, criticalPath, noChanges }) {
  if (noChanges) {
    return { mode: 'suite', suite: 'unit' };
  }
  if (criticalPath) {
    return { mode: 'suites', suites: PR_FULL_SUITES };
  }
  if (widenRequired) {
    return { mode: 'suites', suites: PR_FULL_SUITES };
  }
  if (selected.length === 0) {
    return { mode: 'suite', suite: 'unit' };
  }
  return { mode: 'files', files: selected };
}

function runAffectedTests(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const baseRef = options.baseRef || resolveBaseRef();
  const changed = changedFilesSinceBase(repoRoot, baseRef);

  if (changed.length === 0) {
    console.error(`affected-tests: no changed files against ${baseRef}; running unit suite`);
    runSuite(repoRoot, 'unit');
    return;
  }

  if (shouldRunFullSuite(changed)) {
    console.error('affected-tests: critical CI/runtime files changed; running PR suites (unit, integration, security)');
    for (const suite of PR_FULL_SUITES) {
      runSuite(repoRoot, suite);
    }
    return;
  }

  const allTests = listTestFiles(repoRoot);
  const reverseIndex = buildTransitiveReverseIndex(repoRoot, allTests);
  const selected = pickAffectedTests(changed, allTests, reverseIndex, { detectWiden: true });

  console.error(`affected-tests: base=${baseRef} changed=${changed.length} selected=${selected.length}`);
  console.error(`affected-tests: ${selected.join(' ')}`);

  const plan = resolveRunPlan({
    changedFiles: changed,
    selected,
    widenRequired: selected._widenRequired === true,
    criticalPath: false,
    noChanges: false,
  });

  if (plan.mode === 'suites') {
    // Widen backstop: a source file changed that has no static test dependents.
    // Run all PR suites (unit + integration + security) — a strict superset of
    // the concretely-selected tests — so no integration/security match is lost.
    for (const file of changed) {
      const ext = path.extname(file);
      const isSourceFile = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json'].includes(ext);
      if (!isSourceFile || file.startsWith('tests/') || shouldRunFullSuite([file])) continue;
      const dependents = reverseIndex.get(file);
      if (!dependents || dependents.size === 0) {
        console.error(
          `affected-tests: ${file} has no static test dependents; widening to PR suites (unit+integration+security)`,
        );
      }
    }
    for (const suite of plan.suites) {
      runSuite(repoRoot, suite);
    }
    return;
  }

  if (plan.mode === 'suite') {
    console.error('affected-tests: no affected tests found; running unit suite as smoke');
    runSuite(repoRoot, plan.suite);
    return;
  }

  // plan.mode === 'files'
  runNodeTestFiles(repoRoot, plan.files);
}

module.exports = {
  CRITICAL_PATHS,
  PR_EXCLUDED_SUITES,
  PR_FULL_SUITES,
  buildForwardGraph,
  buildReverseIndex,
  buildTransitiveReverseIndex,
  parseRelativeSpecifiers,
  pickAffectedTests,
  resolveBaseRef,
  resolveRelativeDependency,
  resolveRunPlan,
  shouldRunFullSuite,
  toPosixPath,
  runAffectedTests,
};
