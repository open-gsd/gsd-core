/**
 * stryker.config.mjs
 *
 * Mutation testing configuration for gsd-core.
 *
 * Test runner: 'command' (built into @stryker-mutator/core)
 *   Runs: node --test over the lib test files via the repo's run-tests invocation.
 *
 * Mutate scope: bin/lib/**\/*.cjs, excluding generated files and test files.
 *
 * coverageAnalysis: 'off' — command runner does not support per-mutant coverage
 * thresholds: high=80, low=60, break=50
 * incremental: true — caches results; PR-scoped runs pass --mutate <changed-files>
 *
 * Reports:
 *   - html: reports/mutation/mutation.html
 *   - clear-text (console)
 *   - progress (spinner)
 *
 * NOTE: This is incremental / changed-files-only in CI (--mutate <changed-files>)
 * to stay bounded. Full runs are for local exploration only.
 */

// ADR-457: bin/lib/*.cjs are gitignored build artifacts (compiled from
// src/*.cts by `npm run build:lib`, which the mutation CI job runs via `npm ci`
// → prepare before Stryker). Stryker mutates the *built* .cjs directly — the
// command runner runs the tests with NO rebuild, so each mutation to the
// shipped artifact is seen by the tests. (Mutating src/*.cts instead would
// force a full tsc rebuild per mutant — far too slow for the 30-min CI budget.)
// Large/low-coverage modules are excluded (the command's test set does not
// exercise them, so they would only ever produce survived mutants).
const UNMUTATED = [
  '!get-shit-done/bin/lib/command-aliases.cjs',
  '!get-shit-done/bin/lib/commands.cjs',
  '!get-shit-done/bin/lib/core.cjs',
  '!get-shit-done/bin/lib/install-profiles.cjs',
  '!get-shit-done/bin/lib/installer-migrations.cjs',
  '!get-shit-done/bin/lib/phase.cjs',
  '!get-shit-done/bin/lib/profile-output.cjs',
  '!get-shit-done/bin/lib/state.cjs',
  '!get-shit-done/bin/lib/verify.cjs',
  '!get-shit-done/bin/lib/init.cjs',
  '!get-shit-done/bin/lib/audit.cjs',
  '!get-shit-done/bin/lib/gsd2-import.cjs',
];

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // ── Test runner ──────────────────────────────────────────────────────────────
  testRunner: 'command',
  commandRunner: {
    // Run property + unit tests over lib only (avoids the slow integration
    // suite). NO build step here: Stryker mutates the already-built .cjs and the
    // tests load it directly — adding a build would rebuild over the mutation.
    command: 'node --test tests/context-utilization.property.test.cjs tests/prompt-budget.property.test.cjs tests/frontmatter.property.test.cjs tests/adr-parser.property.test.cjs tests/config-schema.property.test.cjs tests/adr-parser.test.cjs tests/active-workstream-store.test.cjs',
  },

  // ── Files to mutate ──────────────────────────────────────────────────────────
  // The built bin/lib/*.cjs artifacts (ADR-457). CI overrides this with
  // --mutate <changed, covered modules> computed in mutation.yml.
  mutate: [
    'get-shit-done/bin/lib/**/*.cjs',
    '!get-shit-done/bin/lib/**/*.test.cjs',
    ...UNMUTATED,
  ],

  // ── Coverage ─────────────────────────────────────────────────────────────────
  // 'off' is required for the command test runner — it cannot instrument per-mutant.
  coverageAnalysis: 'off',

  // ── Thresholds ───────────────────────────────────────────────────────────────
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },

  // ── Incremental mode ─────────────────────────────────────────────────────────
  // Cache mutation results; re-run only changed mutants on subsequent calls.
  // In CI the workflow computes changed files and passes: stryker run --incremental --mutate <list>
  incremental: true,
  incrementalFile: '.stryker-incremental.json',

  // ── Reporters ────────────────────────────────────────────────────────────────
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/mutation.html',
  },

  // ── Temp directory ───────────────────────────────────────────────────────────
  tempDirName: '.stryker-tmp',

  // ── Ignore patterns ──────────────────────────────────────────────────────────
  ignorePatterns: [
    'node_modules',
    'reports',
    '.stryker-tmp',
    'coverage',
    'hooks/dist',
  ],
};
