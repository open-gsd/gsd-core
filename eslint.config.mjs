import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import pluginN from 'eslint-plugin-n';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Local plugin with custom AST rules
import noSourceGrep from './eslint-rules/no-source-grep.cjs';
import noMagicSleepInTests from './eslint-rules/no-magic-sleep-in-tests.cjs';
import noElapsedAssertion from './eslint-rules/no-elapsed-assertion.cjs';
import noRawRmsyncInTests from './eslint-rules/no-raw-rmsync-in-tests.cjs';

const localPlugin = {
  rules: {
    'no-source-grep': noSourceGrep,
    'no-magic-sleep-in-tests': noMagicSleepInTests,
    'no-elapsed-assertion': noElapsedAssertion,
    'no-raw-rmsync-in-tests': noRawRmsyncInTests,
  },
};

export default tseslint.config(
  // ── Global ignores ─────────────────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '.worktrees/**',
      '.claude/**',
      'coverage/**',
      '**/*.generated.cjs',
      // ADR-457: tsc-generated runtime artifact — lint the src/*.cts source, not the emitted .cjs.
      'get-shit-done/bin/lib/semver-compare.cjs',
      'get-shit-done/bin/lib/code-review-flags.cjs',
      'get-shit-done/bin/lib/context-utilization.cjs',
      'get-shit-done/bin/lib/artifacts.cjs',
      'get-shit-done/bin/lib/command-arg-projection.cjs',
      'get-shit-done/bin/lib/clock.cjs',
      'get-shit-done/bin/lib/ui-safety-gate.cjs',
      'get-shit-done/bin/lib/review-reviewer-selection.cjs',
      'get-shit-done/bin/lib/clusters.cjs',
      'get-shit-done/bin/lib/installer-migrations/001-legacy-orphan-files.cjs',
      'get-shit-done/bin/lib/observability/redaction.cjs',
      'get-shit-done/bin/lib/installer-migration-report.cjs',
      'get-shit-done/bin/lib/prompt-budget.cjs',
      'get-shit-done/bin/lib/secrets.cjs',
      'get-shit-done/bin/lib/phase-lifecycle.cjs',
      'get-shit-done/bin/lib/workstream-name-policy.cjs',
      'get-shit-done/bin/lib/decisions.cjs',
      'get-shit-done/bin/lib/validate.cjs',
      'get-shit-done/bin/lib/schema-detect.cjs',
      'get-shit-done/bin/lib/runtime-name-policy.cjs',
      'get-shit-done/bin/lib/runtime-slash.cjs',
      'get-shit-done/bin/lib/observability/event.cjs',
      'get-shit-done/bin/lib/workstream-inventory-builder.cjs',
      'get-shit-done/bin/lib/plan-scan.cjs',
      'get-shit-done/bin/lib/fallow-runner.cjs',
      'get-shit-done/bin/lib/project-root.cjs',
      'get-shit-done/bin/lib/installer-migration-authoring.cjs',
      'get-shit-done/bin/lib/update-context.cjs',
      'get-shit-done/bin/lib/installer-migrations/000-first-time-baseline.cjs',
      'get-shit-done/bin/lib/runtime-homes.cjs',
      'get-shit-done/bin/lib/model-catalog.cjs',
      'get-shit-done/bin/lib/configuration.cjs',
      'get-shit-done/bin/lib/state-document.cjs',
      'get-shit-done/bin/lib/shell-command-projection.cjs',
      'get-shit-done/bin/lib/security.cjs',
      'get-shit-done/bin/lib/command-aliases.cjs',
      'get-shit-done/bin/lib/config-schema.cjs',
      'get-shit-done/bin/lib/model-profiles.cjs',
      'get-shit-done/bin/lib/installer-migrations/002-codex-legacy-hooks-json.cjs',
      'get-shit-done/bin/lib/observability/logger.cjs',
      'get-shit-done/bin/lib/active-workstream-store.cjs',
      'get-shit-done/bin/lib/adr-parser.cjs',
      'get-shit-done/bin/lib/graphify.cjs',
      'get-shit-done/bin/lib/install-profiles.cjs',
      'get-shit-done/bin/lib/intel.cjs',
      'get-shit-done/bin/lib/installer-migrations.cjs',
      'get-shit-done/bin/lib/worktree-safety.cjs',
      'get-shit-done/bin/lib/planning-workspace.cjs',
      'get-shit-done/bin/lib/runtime-artifact-layout.cjs',
      'get-shit-done/bin/lib/command-routing-hub.cjs',
      'get-shit-done/bin/lib/core.cjs',
      'get-shit-done/bin/lib/drift.cjs',
      'get-shit-done/bin/lib/cjs-command-router-adapter.cjs',
      'get-shit-done/bin/lib/phase-command-router.cjs',
      'get-shit-done/bin/lib/surface.cjs',
      'get-shit-done/bin/lib/roadmap-upgrade.cjs',
      'get-shit-done/bin/lib/config-types.cjs',
      'get-shit-done/bin/lib/phases-command-router.cjs',
      'get-shit-done/bin/lib/verify-command-router.cjs',
      'get-shit-done/bin/lib/init-command-router.cjs',
      'get-shit-done/bin/lib/agent-command-router.cjs',
      'get-shit-done/bin/lib/task-command-router.cjs',
      'get-shit-done/bin/lib/validate-command-router.cjs',
      'get-shit-done/bin/lib/workstream-inventory.cjs',
      'get-shit-done/bin/lib/roadmap-command-router.cjs',
      'get-shit-done/bin/lib/state-command-router.cjs',
      'get-shit-done/bin/lib/gap-checker.cjs',
      'get-shit-done/bin/lib/config.cjs',
      'get-shit-done/bin/lib/profile-output.cjs',
      'get-shit-done/bin/lib/commands.cjs',
      'get-shit-done/bin/lib/state.cjs',
      'get-shit-done/bin/lib/milestone.cjs',
      'get-shit-done/bin/lib/docs.cjs',
      'get-shit-done/bin/lib/check-command-router.cjs',
      'get-shit-done/bin/lib/frontmatter.cjs',
      'get-shit-done/bin/lib/learnings.cjs',
      'get-shit-done/bin/lib/gsd2-import.cjs',
      'get-shit-done/bin/lib/profile-pipeline.cjs',
      'get-shit-done/bin/lib/template.cjs',
      'get-shit-done/bin/lib/uat.cjs',
      'get-shit-done/bin/lib/workstream.cjs',
      'get-shit-done/bin/lib/roadmap.cjs',
      'get-shit-done/bin/lib/audit.cjs',
    ],
  },

  // ── src/**/*.cts — TypeScript runtime sources (ADR-457 build-at-publish) ─────
  // First-class type-aware linting on the migrated source. The TS compiler
  // (`npm run build:lib`, strict + noEmitOnError) is the primary type gate;
  // these rules add lint-level coverage. warn-first per the harness convention.
  {
    files: ['src/**/*.cts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.build.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ── get-shit-done/bin/**/*.cjs + scripts/**/*.cjs ───────────────────────────
  // CommonJS Node files: js.recommended + eslint-plugin-n + local plugin rules
  {
    files: ['get-shit-done/bin/**/*.cjs', 'scripts/**/*.cjs'],
    plugins: {
      n: pluginN,
      local: localPlugin,
    },
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Generic quality rules
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Downgraded from recommended error → warn (pre-existing violations; follow-up to fix)
      'no-useless-escape': 'warn',
      'no-unsafe-finally': 'warn',
      // eslint-plugin-n rules
      'n/no-process-exit': 'warn',
      // Local rules — warn for now; flip to error after cleanup phases
      'local/no-source-grep': 'warn',
    },
  },

  // ── tests/**/*.test.cjs ─────────────────────────────────────────────────────
  {
    files: ['tests/**/*.test.cjs'],
    plugins: {
      'no-only-tests': noOnlyTests,
      local: localPlugin,
    },
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-only-tests/no-only-tests': 'error',
      // Timing anti-patterns — warn for now; flip to error after cleanup
      'local/no-magic-sleep-in-tests': 'warn',
      'local/no-elapsed-assertion': 'warn',
      // Ban raw fs.rmSync in tests — use helpers.cleanup() for Windows-EBUSY retry budget
      'local/no-raw-rmsync-in-tests': 'error',
      // Ban raw setTimeout sync + elapsed/duration-style assertions via no-restricted-syntax
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'AwaitExpression > NewExpression[callee.name="Promise"] ArrowFunctionExpression CallExpression[callee.name="setTimeout"]',
          message: 'Raw setTimeout used for synchronization in tests. Use proper async patterns instead.',
        },
        {
          selector: 'CallExpression[callee.object.name="Atomics"][callee.property.name="wait"]',
          message: 'Atomics.wait() used as a sleep in tests. Use a proper async wait pattern instead.',
        },
      ],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Downgraded from recommended error → warn (pre-existing violations; follow-up to fix)
      'no-useless-escape': 'warn',
      'no-regex-spaces': 'warn',
      'no-control-regex': 'warn',
      'no-irregular-whitespace': 'warn',
    },
  },
);
