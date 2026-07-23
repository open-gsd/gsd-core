// PERMANENT LOAD-BEARING FIXTURE for #1259 / #2126 — DO NOT delete or rename to `*.test.cjs`.
//
// A KNOWN-CLEAN, lint-scoped `.cjs` companion to `_ff_lint_violation.cjs`. It has NO
// `local/no-source-grep` violation, so the prohibition-enforcement real-runner tests can use it as
// the "clean target" for a NON-VACUOUS pass — the rule RUNS on it (enabled via the flat-config
// block below) and finds nothing.
//
// Why a `.cjs` and not `src/clock.cts`: linting a `src/**/*.cts` file is type-aware
// (`recommendedTypeChecked` + `parserOptions.project`), which loads the whole `tsconfig.build.json`
// program on every eslint spawn (~2s, CPU-heavy). The real-runner tests spawn eslint repeatedly and,
// under `--test-concurrency`, those full-program type-checks oversubscribe the bench CPU and blow the
// 60s subprocess bound (#2126). A plain `.cjs` is linted non-type-aware (~0.8s) — same coverage of
// the AST-only `no-source-grep` rule, no starvation.
//
// PLAIN `.cjs` (NOT `*.test.cjs`) on purpose — same reason as the violation fixture: keep it OFF the
// `node --test` runner glob so it is only ever linted, never executed.
'use strict';

module.exports = {};
