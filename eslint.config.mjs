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
import noTautologicalAssert from './eslint-rules/no-tautological-assert.cjs';
import noAdhocMarkdownParsing from './eslint-rules/no-adhoc-markdown-parsing.cjs';
import noPathLiteralInAssert from './eslint-rules/no-path-literal-in-assert.cjs';
import noPosixModeBitAssert from './eslint-rules/no-posix-mode-bit-assert.cjs';
import noUnguardedNonportableExec from './eslint-rules/no-unguarded-nonportable-exec.cjs';
import noCrlfFragileSplit from './eslint-rules/no-crlf-fragile-split.cjs';
import noHardcodedTmp from './eslint-rules/no-hardcoded-tmp.cjs';
import noBareNpmExec from './eslint-rules/no-bare-npm-exec.cjs';
import requireUserprofileWithHome from './eslint-rules/require-userprofile-with-home.cjs';
import normalizePathInContent from './eslint-rules/normalize-path-in-content.cjs';
import requireFsOpFallback from './eslint-rules/require-fs-op-fallback.cjs';

const localPlugin = {
  rules: {
    'no-source-grep': noSourceGrep,
    'no-magic-sleep-in-tests': noMagicSleepInTests,
    'no-elapsed-assertion': noElapsedAssertion,
    'no-raw-rmsync-in-tests': noRawRmsyncInTests,
    'no-tautological-assert': noTautologicalAssert,
    'no-adhoc-markdown-parsing': noAdhocMarkdownParsing,
    'no-path-literal-in-assert': noPathLiteralInAssert,
    'no-posix-mode-bit-assert': noPosixModeBitAssert,
    'no-unguarded-nonportable-exec': noUnguardedNonportableExec,
    'no-crlf-fragile-split': noCrlfFragileSplit,
    'no-hardcoded-tmp': noHardcodedTmp,
    'no-bare-npm-exec': noBareNpmExec,
    'require-userprofile-with-home': requireUserprofileWithHome,
    'normalize-path-in-content': normalizePathInContent,
    'require-fs-op-fallback': requireFsOpFallback,
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
      'gsd-core/bin/lib/semver-compare.cjs',
      'gsd-core/bin/lib/host-integration.cjs',
      'gsd-core/bin/lib/install-engine.cjs',
      'gsd-core/bin/lib/capability-loader.cjs',
      'gsd-core/bin/lib/capability-source.cjs',
      'gsd-core/bin/lib/capability-ledger.cjs',
      'gsd-core/bin/lib/capability-trust.cjs',
      'gsd-core/bin/lib/capability-lifecycle.cjs',
      'gsd-core/bin/lib/capability-consent.cjs',
      'gsd-core/bin/lib/capability-lock.cjs',
      'gsd-core/bin/lib/resolution.cjs',
      'gsd-core/bin/lib/plan-drift-guard.cjs',
      'gsd-core/bin/lib/cli-exit.cjs',
      'gsd-core/bin/lib/edge-probe.cjs',
      'gsd-core/bin/lib/probe-core.cjs',
      'gsd-core/bin/lib/prohibition-enforcement.cjs',
      'gsd-core/bin/lib/code-review-flags.cjs',
      'gsd-core/bin/lib/context-utilization.cjs',
      'gsd-core/bin/lib/artifacts.cjs',
      'gsd-core/bin/lib/assumption-delta.cjs',
      'gsd-core/bin/lib/state-transition.cjs',
      'gsd-core/bin/lib/command-arg-projection.cjs',
      'gsd-core/bin/lib/clock.cjs',
      'gsd-core/bin/lib/ui-safety-gate.cjs',
      'gsd-core/bin/lib/review-reviewer-selection.cjs',
      'gsd-core/bin/lib/clusters.cjs',
      'gsd-core/bin/lib/installer-migrations/001-legacy-orphan-files.cjs',
      'gsd-core/bin/lib/observability/redaction.cjs',
      'gsd-core/bin/lib/installer-migration-report.cjs',
      'gsd-core/bin/lib/prompt-budget.cjs',
      'gsd-core/bin/lib/secrets.cjs',
      'gsd-core/bin/lib/phase-lifecycle.cjs',
      'gsd-core/bin/lib/workstream-name-policy.cjs',
      'gsd-core/bin/lib/decisions.cjs',
      'gsd-core/bin/lib/validate.cjs',
      'gsd-core/bin/lib/schema-detect.cjs',
      'gsd-core/bin/lib/runtime-name-policy.cjs',
      'gsd-core/bin/lib/runtime-slash.cjs',
      'gsd-core/bin/lib/observability/event.cjs',
      'gsd-core/bin/lib/workstream-inventory-builder.cjs',
      'gsd-core/bin/lib/plan-scan.cjs',
      'gsd-core/bin/lib/fallow-runner.cjs',
      'gsd-core/bin/lib/project-root.cjs',
      'gsd-core/bin/lib/installer-migration-authoring.cjs',
      'gsd-core/bin/lib/update-context.cjs',
      'gsd-core/bin/lib/installer-migrations/000-first-time-baseline.cjs',
      'gsd-core/bin/lib/runtime-homes.cjs',
      'gsd-core/bin/lib/model-catalog.cjs',
      'gsd-core/bin/lib/configuration.cjs',
      'gsd-core/bin/lib/state-document.cjs',
      'gsd-core/bin/lib/shell-command-projection.cjs',
      'gsd-core/bin/lib/security.cjs',
      'gsd-core/bin/lib/command-aliases.cjs',
      'gsd-core/bin/lib/config-schema.cjs',
      'gsd-core/bin/lib/model-profiles.cjs',
      'gsd-core/bin/lib/model-resolver.cjs',
      'gsd-core/bin/lib/loop-resolver.cjs',
      'gsd-core/bin/lib/capability-state.cjs',
      'gsd-core/bin/lib/capability-activation.cjs',
      'gsd-core/bin/lib/federated-config.cjs',
      'gsd-core/bin/lib/installer-migrations/002-codex-legacy-hooks-json.cjs',
      'gsd-core/bin/lib/installer-migrations/003-rename-get-shit-done-to-gsd-core.cjs',
      'gsd-core/bin/lib/installer-migrations/004-prune-stale-pristine-snapshots.cjs',
      'gsd-core/bin/lib/observability/logger.cjs',
      'gsd-core/bin/lib/active-workstream-store.cjs',
      'gsd-core/bin/lib/adr-parser.cjs',
      'gsd-core/bin/lib/graphify.cjs',
      'gsd-core/bin/lib/graphify-command-router.cjs',
      'gsd-core/bin/lib/audit-command-router.cjs',
      'gsd-core/bin/lib/intel-command-router.cjs',
      'gsd-core/bin/lib/install-profiles.cjs',
      'gsd-core/bin/lib/intel.cjs',
      'gsd-core/bin/lib/installer-migrations.cjs',
      'gsd-core/bin/lib/worktree-safety.cjs',
      'gsd-core/bin/lib/worktree-base-ref.cjs',
      'gsd-core/bin/lib/planning-workspace.cjs',
      'gsd-core/bin/lib/command-roster.cjs',
      'gsd-core/bin/lib/runtime-artifact-conversion.cjs',
      'gsd-core/bin/lib/runtime-artifact-install-plan.cjs',
      'gsd-core/bin/lib/runtime-artifact-layout.cjs',
      'gsd-core/bin/lib/runtime-config-adapter-registry.cjs',
      'gsd-core/bin/lib/runtime-hooks-surface.cjs',
      'gsd-core/bin/lib/command-routing-hub.cjs',
      'gsd-core/bin/lib/core-utils.cjs',
      'gsd-core/bin/lib/io.cjs',
      'gsd-core/bin/lib/phase-id.cjs',
      'gsd-core/bin/lib/config-loader.cjs',
      'gsd-core/bin/lib/phase-locator.cjs',
      'gsd-core/bin/lib/roadmap-parser.cjs',
      'gsd-core/bin/lib/drift.cjs',
      'gsd-core/bin/lib/cjs-command-router-adapter.cjs',
      'gsd-core/bin/lib/phase-command-router.cjs',
      'gsd-core/bin/lib/surface.cjs',
      'gsd-core/bin/lib/roadmap-upgrade.cjs',
      'gsd-core/bin/lib/config-types.cjs',
      'gsd-core/bin/lib/phases-command-router.cjs',
      'gsd-core/bin/lib/verify-command-router.cjs',
      'gsd-core/bin/lib/verification.cjs',
      'gsd-core/bin/lib/verification-command-router.cjs',
      'gsd-core/bin/lib/eval.cjs',
      'gsd-core/bin/lib/eval-command-router.cjs',
      'gsd-core/bin/lib/init-command-router.cjs',
      'gsd-core/bin/lib/agent-command-router.cjs',
      'gsd-core/bin/lib/agent-install-check.cjs',
      'gsd-core/bin/lib/task-command-router.cjs',
      'gsd-core/bin/lib/validate-command-router.cjs',
      'gsd-core/bin/lib/workstream-inventory.cjs',
      'gsd-core/bin/lib/roadmap-command-router.cjs',
      'gsd-core/bin/lib/state-command-router.cjs',
      'gsd-core/bin/lib/gap-checker.cjs',
      'gsd-core/bin/lib/config.cjs',
      'gsd-core/bin/lib/profile-output.cjs',
      'gsd-core/bin/lib/commands.cjs',
      'gsd-core/bin/lib/state.cjs',
      'gsd-core/bin/lib/milestone.cjs',
      'gsd-core/bin/lib/phase.cjs',
      'gsd-core/bin/lib/verify.cjs',
      'gsd-core/bin/lib/init.cjs',
      'gsd-core/bin/lib/docs.cjs',
      'gsd-core/bin/lib/check-command-router.cjs',
      'gsd-core/bin/lib/frontmatter.cjs',
      'gsd-core/bin/lib/learnings.cjs',
      'gsd-core/bin/lib/gsd2-import.cjs',
      'gsd-core/bin/lib/profile-pipeline.cjs',
      'gsd-core/bin/lib/template.cjs',
      'gsd-core/bin/lib/uat.cjs',
      'gsd-core/bin/lib/coverage.cjs',
      'gsd-core/bin/lib/uat-predicate.cjs',
      'gsd-core/bin/lib/workstream.cjs',
      'gsd-core/bin/lib/roadmap.cjs',
      'gsd-core/bin/lib/audit.cjs',
      'gsd-core/bin/lib/research-store.cjs',
      'gsd-core/bin/lib/research-provider.cjs',
      'gsd-core/bin/lib/package-legitimacy.cjs',
      // ADR-457: tsc-generated runtime artifact — lint the src/git-base-branch.cts source.
      'gsd-core/bin/lib/git-base-branch.cjs',
      // ADR-1213: tsc-generated runtime artifact — lint the src/capability-writer.cts source.
      'gsd-core/bin/lib/capability-writer.cjs',
      // issue #1754: tsc-generated runtime artifact — lint the src/cli-skew-check.cts source.
      'gsd-core/bin/lib/cli-skew-check.cjs',
      // issue #1355: tsc-generated runtime artifact — lint the src/teams-status.cts source.
      'gsd-core/bin/lib/teams-status.cjs',
      // ADR-1372: tsc-generated runtime artifact — lint the src/markdown-sectionizer.cts source.
      'gsd-core/bin/lib/markdown-sectionizer.cjs',
      // ADR-1239 Phase C-1 (#1680): tsc-generated — lint src/embedding-adapter.cts + src/adapter-declarative.cts.
      'gsd-core/bin/lib/embedding-adapter.cjs',
      'gsd-core/bin/lib/adapter-declarative.cjs',
      'gsd-core/bin/lib/adapter-imperative.cjs',
      'gsd-core/bin/lib/model-adapter.cjs',
      'gsd-core/bin/lib/hook-bus.cjs',
      'gsd-core/bin/lib/state-io.cjs',
      'gsd-core/bin/lib/external-descriptor-trust.cjs',
      'gsd-core/bin/lib/mcp-server.cjs',
    ],
  },

  // ── src/**/*.cts — TypeScript runtime sources (ADR-457 build-at-publish) ─────
  // First-class type-aware linting on the migrated source. The TS compiler
  // (`npm run build:lib`, strict + noEmitOnError) is the primary type gate;
  // these rules add lint-level coverage. warn-first per the harness convention.
  {
    files: ['src/**/*.cts'],
    plugins: {
      local: localPlugin,
    },
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.build.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // ADR-1372 T7: enforce use of the markdown-sectionizer seam; grandfather
      // pre-migration sites with // allow-adhoc-markdown: <reason>
      'local/no-adhoc-markdown-parsing': 'error',
      // ADR-1703 Phase 5: flag path-returning calls interpolated into content
      // (markdown @-references, workflow files, generated docs) without POSIX
      // normalization. Promoted to 'error' after precision review (path.basename
      // excluded; content heuristic tightened to genuine reference/config-dir
      // markers). See RULESET.CONTENT-PATH-NORMALIZATION in CONTEXT.md.
      'local/normalize-path-in-content': 'error',
      // ADR-1703 Phase 6: flag an unguarded fs.rename/fs.renameSync (the
      // atomic-publish primitive) that lacks a transient-errno fallback
      // (EPERM/EBUSY/EACCES retry or a Windows platform guard). See
      // DEFECT.WINDOWS-FS-OPS in CONTEXT.md.
      'local/require-fs-op-fallback': 'error',
    },
  },

  // ── bin/install.js + scripts/build-hooks.js — ADR-1703 Phase 6 glob expansion ─
  // The top-level `bin/install.js` (generated installer) and `scripts/build-hooks.js`
  // (the build-side atomic-replace helper) are the two production surfaces named by
  // DEFECT.WINDOWS-FS-OPS that were NOT covered by the src/**/*.cts / gsd-core/bin/**/*.cjs
  // globs (ADR-1703 L124-126). This block brings them under the two production
  // portability rules. It deliberately does NOT apply the full js.recommended set —
  // bin/install.js is ~12k lines of generated code; the ADR's mandate is the
  // portability defect surface, not a broader generated-code style sweep.
  {
    files: ['bin/install.js', 'scripts/build-hooks.js'],
    plugins: {
      local: localPlugin,
    },
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'local/normalize-path-in-content': 'error',
      'local/require-fs-op-fallback': 'error',
    },
  },

  // ── gsd-core/bin/**/*.cjs + scripts/**/*.cjs ───────────────────────────
  // CommonJS Node files: js.recommended + eslint-plugin-n + local plugin rules
  {
    files: ['gsd-core/bin/**/*.cjs', 'scripts/**/*.cjs'],
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
      'n/no-process-exit': 'error',
      'n/no-path-concat': 'error',
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
      // Timing anti-patterns — ratcheted to error after cleanup (all violations fixed)
      'local/no-magic-sleep-in-tests': 'error',
      'local/no-elapsed-assertion': 'warn',
      // Ban raw fs.rmSync in tests — use helpers.cleanup() for Windows-EBUSY retry budget
      'local/no-raw-rmsync-in-tests': 'error',
      // Ban tautological assertions (always-truthy arg or identical-literal equality)
      'local/no-tautological-assert': 'error',
      // Ban source-grep pattern in tests — use require() + behavior assertions instead
      'local/no-source-grep': 'error',
      // Ban path-returning calls compared to hardcoded POSIX-slash literals (fails on Windows)
      'local/no-path-literal-in-assert': 'error',
      // Ban POSIX mode-bit assertions compared to octal literals (fails on Windows)
      'local/no-posix-mode-bit-assert': 'error',
      // Ban unguarded chmod exec-bit + sh/bash -c combos (fails on Windows Git Bash)
      'local/no-unguarded-nonportable-exec': 'error',
      // Ban CRLF-fragile file-content splits and regex patterns (ADR-1703 Phase 4)
      'local/no-crlf-fragile-split': 'error',
      // Ban hardcoded /tmp/ paths in fs.* calls (ADR-1703 Phase 4)
      'local/no-hardcoded-tmp': 'error',
      // Ban bare npm exec without shell:true (ADR-1703 Phase 4)
      'local/no-bare-npm-exec': 'error',
      // Require USERPROFILE alongside HOME assignments (ADR-1703 Phase 4)
      'local/require-userprofile-with-home': 'error',
      // Ban raw setTimeout sync + elapsed/duration-style assertions via no-restricted-syntax
      'no-restricted-syntax': [
        'error',
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
      'no-control-regex': 'error',
      'no-irregular-whitespace': 'warn',
    },
  },

  // ── #1279 lint-rule fail-first fixture ──────────────────────────────────────
  // `tests/_ff_lint_violation.cjs` is a PLAIN `.cjs` (NOT `*.test.cjs`) on purpose: it is a KNOWN
  // `local/no-source-grep` violation that `defaultProveFailFirst` lints to machine-prove the rule
  // has teeth, and it must stay OFF the `node --test` runner glob (executing it ENOENTs on the
  // intentional `lib/foo.cjs` path). It still needs the `local` plugin registered so its inline
  // `/* eslint-disable local/no-source-grep */` resolves (otherwise `eslint .` errors "rule not
  // found") and the violation lands in `suppressedMessages` (which the prover reads), keeping the
  // project's own `eslint .` green. (#1279)
  {
    files: ['tests/_ff_lint_violation.cjs'],
    plugins: { local: localPlugin },
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'local/no-source-grep': 'error' },
  },
);
