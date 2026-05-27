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

function resolveRelativeDependency(repoRoot, fromAbs, specifier) {
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
    path.join(base, 'index.mjs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return toPosixPath(path.relative(repoRoot, candidate));
    }
  }

  return null;
}

function buildReverseIndex(repoRoot, testFiles) {
  const reverse = new Map();
  for (const testFile of testFiles) {
    const absTest = path.join(repoRoot, testFile);
    const source = readFileSync(absTest, 'utf8');
    const specs = parseRelativeSpecifiers(source);
    for (const specifier of specs) {
      const dep = resolveRelativeDependency(repoRoot, absTest, specifier);
      if (!dep) continue;
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(testFile);
    }
  }
  return reverse;
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

function pickAffectedTests(changedFiles, allTests, reverseIndex) {
  const selected = new Set();

  for (const file of changedFiles) {
    if (file.startsWith('tests/') && file.endsWith('.test.cjs')) {
      selected.add(file);
    }
    const dependents = reverseIndex.get(file);
    if (dependents) {
      for (const testFile of dependents) selected.add(testFile);
    }
  }

  for (const file of changedFiles) {
    const stem = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (!stem) continue;
    for (const testFile of allTests) {
      if (testFile.toLowerCase().includes(stem)) selected.add(testFile);
    }
  }

  // Drop any file whose suite is push-only. This is the single chokepoint —
  // it catches direct-change, reverse-index, AND stem-match selections.
  for (const file of selected) {
    const suite = suiteOf(path.basename(file));
    if (PR_EXCLUDED_SUITES.has(suite)) selected.delete(file);
  }

  // When nothing maps, return an empty array. The caller decides the fallback.
  return [...selected].sort();
}

function changedFilesSinceBase(repoRoot, baseRef) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`],
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
  const reverseIndex = buildReverseIndex(repoRoot, allTests);
  const selected = pickAffectedTests(changed, allTests, reverseIndex);

  console.error(`affected-tests: base=${baseRef} changed=${changed.length} selected=${selected.length}`);
  console.error(`affected-tests: ${selected.join(' ')}`);

  if (selected.length === 0) {
    console.error('affected-tests: no affected tests found; running unit suite as smoke');
    runSuite(repoRoot, 'unit');
    return;
  }

  runNodeTestFiles(repoRoot, selected);
}

module.exports = {
  CRITICAL_PATHS,
  PR_EXCLUDED_SUITES,
  PR_FULL_SUITES,
  buildReverseIndex,
  parseRelativeSpecifiers,
  pickAffectedTests,
  resolveBaseRef,
  shouldRunFullSuite,
  toPosixPath,
  runAffectedTests,
};
