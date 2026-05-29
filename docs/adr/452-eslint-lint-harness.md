# ADR 452: Adopt standard ESLint flat-config lint harness

- **Status:** Accepted
- **Date:** 2026-05-28

This codebase adopts ESLint flat config (eslint ≥ 9) with `typescript-eslint`, `eslint-plugin-n`, `eslint-plugin-no-only-tests`, and a local AST-rule plugin as the canonical lint harness, replacing the homegrown regex-based `scripts/lint-*.cjs` scripts. The ESLint harness becomes the single enforcement point for import-graph, Node API, and test-rigor rules. The three test-rigor rules (`local/no-source-grep`, `local/no-magic-sleep-in-tests`, `local/no-elapsed-assertion`) initially ship at `warn`; a follow-up issue (tracked at #453) promotes them to `error` after the cleanup phases merge.

## Context

### Existing homegrown regex harness

`scripts/lint-no-source-grep.cjs`, `scripts/lint-no-magic-sleep.cjs`, and related scripts implement test-rigor guards as regular-expression line scanners over raw source text. This approach has several structural weaknesses:

- **False positives** — regex on raw text fires on string literals, comments, and doc blocks that are not code paths.
- **No AST context** — the regex scanners cannot distinguish a banned call inside a helper wrapper from a banned call inside a live test assertion.
- **No incremental mode** — the scripts always scan the entire tree; they have no ESLint-style `--cache`, `--fix`, or `--changed` modes.
- **No editor integration** — IDEs speak LSP/ESLint, not project-local shell scripts; contributors see violations only in CI.
- **Maintenance cost** — each new rule requires a new bespoke script with its own exit-code wiring.

### Type-aware linting stopgap

`tsconfig.lint.json` was introduced to give `tsc --noEmit` access to the hand-written `.cjs` files alongside the generated ones. It is explicitly described in the codebase as a stopgap pending a proper type-aware ESLint setup.

### Generated vs hand-written split

Approximately 59 hand-written and 13 generated `.cjs` files currently coexist in `get-shit-done/bin/lib/`. The hand-written files are not checked by `typescript-eslint` type-aware rules because `tsconfig.lint.json` is not wired into an ESLint project. ADR 457 (`457-generated-cjs-single-source.md`) proposes collapsing this split; the present ADR is a prerequisite: the ESLint harness must exist before the collapse can surface type errors.

## Decision

1. **Adopt ESLint flat config** (`eslint.config.mjs` at repo root) with:
   - `typescript-eslint` (type-aware rules enabled via `tsconfig.lint.json` project reference)
   - `eslint-plugin-n` for Node API and `require()` graph enforcement
   - `eslint-plugin-no-only-tests` (`no-only-tests/no-only-tests`) to prevent `test.only` / `describe.only` leaking into CI
   - A local plugin at `scripts/eslint-rules/` that exposes the AST-rewrite of the three homegrown test-rigor rules:
     - `local/no-source-grep` — bans `readFileSync` on source files + `.includes()/.match()/.startsWith()` on the bound variable; also bans `assert.match/doesNotMatch` on `.stdout/.stderr` without JSON round-trip
     - `local/no-magic-sleep-in-tests` — bans `setTimeout`/`sleep`/`delay` calls inside `test()` / `it()` / `describe()` bodies
     - `local/no-elapsed-assertion` — bans `assert` on elapsed-time values (e.g., `Date.now() - start > N`, `process.hrtime`, `performance.now()` comparisons in assertions)

2. **Phase in at `warn`**. All three `local/*` rules ship at severity `warn` from the initial merge. The CI lint gate (`npm run lint`) does not fail on warnings; it does emit them as annotation. A dedicated follow-up (tracked at #453) flips all three to `error` after the cleanup phases that eliminate existing violations have merged.

3. **Retire homegrown scripts**. `scripts/lint-no-source-grep.cjs` and all sibling regex-scanner scripts are deleted in the same PR that introduces the ESLint config. The CI step that called them is replaced by a single `npm run lint` invocation.

4. **`no-restricted-syntax` bans** (in `eslint.config.mjs`, severity `error` from day one):
   - `CallExpression[callee.name='setTimeout']` inside `Program > ExpressionStatement` (top-level sleeps — catches a different shape than `local/no-magic-sleep-in-tests`)
   - `MemberExpression[property.name='only'][object.name=/^(test|it|describe)$/]` as a belt-and-suspenders backstop alongside `eslint-plugin-no-only-tests`

5. **`eslint-plugin-n`** enforces:
   - `n/no-missing-require` — catches import-graph drift for hand-written CJS files
   - `n/no-unsupported-features/es-syntax` against `engines.node` (`>=22.0.0`)

6. **Editor integration**. Commit the recommended `.vscode/extensions.json` entry for `dbaeumer.vscode-eslint` and an `.editorconfig` fallback so contributors see inline violations without running CI.

## Consequences

### For contributors

- ESLint runs in CI (`npm run lint`) alongside the test suite. A clean lint is required before a PR is mergeable.
- The three test-rigor rules fire as warnings initially; they become errors after #453 merges. Violations added after the initial cleanup phase will block CI.
- Existing `// allow-test-rule: <reason>` comments in `.cjs` files translate to ESLint `// eslint-disable-next-line local/no-source-grep -- <reason>` comments. The old exemption syntax is no longer recognized.
- `test.only` / `describe.only` committed to any non-scratch file fail CI immediately (`error` from day one).

### For the test-rigor audit

- Violations of `local/no-source-grep`, `local/no-magic-sleep-in-tests`, and `local/no-elapsed-assertion` are now surfaced in the IDE and in CI annotations before a PR is opened, removing the current pattern of discovering violations only in PR review.
- The `no-elapsed-assertion` rule enforces the clock-seam pattern codified in ADR 456 (`456-test-rigor-architecture.md`): tests that assert on elapsed time must use the injectable clock seam instead of wall-clock assertions.

### For ADR 457

- The ESLint harness with `typescript-eslint` type-aware rules is a prerequisite for collapsing the hand-written/generated `.cjs` split. Once `tsconfig.lint.json` is wired into ESLint's project references, `typescript-eslint` will surface type drift between the hand-written CJS surface and the TS source.

## Rejected Alternatives

**(a) Keep the homegrown regex harness.** Rejected. False positives, no AST context, no editor integration, and per-rule maintenance cost all compound over time. The homegrown scripts solved the immediate gap but are not a sustainable lint surface.

**(b) Legacy `.eslintrc` format.** Rejected. ESLint 9 deprecated `.eslintrc`; flat config is the supported path for new plugins and type-aware rules. Starting on a deprecated format incurs migration debt immediately.

**(c) Per-file `ts-check` only (no ESLint).** Rejected. `@ts-check` in `.cjs` files gives type feedback inside the file but does not enforce import-graph, test-rigor, or no-only-tests rules. It is a supplementary aid, not a lint harness.

## References

- Tracking issue: [#452](https://github.com/open-gsd/get-shit-done-redux/issues/452)
- Follow-up (warn → error): [#453](https://github.com/open-gsd/get-shit-done-redux/issues/453)
- Test-rigor architecture: `456-test-rigor-architecture.md`
- Generated CJS collapse (future): `457-generated-cjs-single-source.md`
- Homegrown scripts retired: `scripts/lint-no-source-grep.cjs`, `scripts/lint-no-magic-sleep.cjs`
- Stopgap: `tsconfig.lint.json`
