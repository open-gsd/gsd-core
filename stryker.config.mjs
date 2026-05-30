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

// Generated files that must NEVER be mutated
const GENERATED_FILES = [
  '!get-shit-done/bin/lib/configuration.cjs',   // GENERATED — sdk/src/config/index.ts
  '!get-shit-done/bin/lib/command-aliases.cjs',  // GENERATED
  '!get-shit-done/bin/lib/commands.cjs',         // GENERATED
  '!get-shit-done/bin/lib/core.cjs',             // GENERATED
  '!get-shit-done/bin/lib/install-profiles.cjs', // GENERATED
  '!get-shit-done/bin/lib/installer-migrations.cjs', // GENERATED
  '!get-shit-done/bin/lib/phase.cjs',            // GENERATED
  '!get-shit-done/bin/lib/profile-output.cjs',   // GENERATED
  '!get-shit-done/bin/lib/state.cjs',            // GENERATED
  '!get-shit-done/bin/lib/verify.cjs',           // GENERATED
  '!get-shit-done/bin/lib/init.cjs',             // GENERATED
  '!get-shit-done/bin/lib/audit.cjs',            // GENERATED
  '!get-shit-done/bin/lib/gsd2-import.cjs',      // GENERATED
];

/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // ── Test runner ──────────────────────────────────────────────────────────────
  testRunner: 'command',
  commandRunner: {
    // Run property tests + unit tests over lib only.
    // Deliberately avoids running the full integration suite (slow).
    command: 'node --test tests/context-utilization.property.test.cjs tests/prompt-budget.property.test.cjs tests/frontmatter.property.test.cjs tests/adr-parser.property.test.cjs tests/config-schema.property.test.cjs tests/adr-parser.test.cjs tests/active-workstream-store.test.cjs',
  },

  // ── Files to mutate ──────────────────────────────────────────────────────────
  mutate: [
    'get-shit-done/bin/lib/**/*.cjs',
    '!get-shit-done/bin/lib/**/*.test.cjs',
    ...GENERATED_FILES,
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
