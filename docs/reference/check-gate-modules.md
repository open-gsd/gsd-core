# Check gate modules

> Reference. Support modules, ESLint boundaries and behavior differences for the `check <gate>`
> router (#5139, epic #5056). The overview is in [Architecture](../ARCHITECTURE.md#check-gate-modules-srcgatects-srccheck-command-routercts-5139-epic-5056).

`src/check-command-router.cts` (261 lines) parses argv, calls the gate, and formats the result through one output site, `emitGateResult`. A gate's stdout and exit code are byte-identical to the pre-refactor router; 149 golden files pin them (`tests/check-router-cutover-equivalence.test.cjs`).

Support modules shared by the gates: `gate-config` (workflow switches, read quietly), `gate-args` (argument parsing), `gate-phase-context` (containment, phase-directory resolution, the tolerant file read and the degraded verify-probe verdict), `decision-coverage-support` (decision extraction and matching), and `check-auto-mode` (the `check auto-mode` state reader). XML decision-tag extraction lives in the markdown sectionizer seam (`src/markdown-sectionizer.cts`), and `type: tdd` detection in the Frontmatter Module (`frontmatterKeyHasValue`).

Two ESLint boundaries in `eslint.config.mjs` keep the split honest: a gate module imports no io module (`./io.cjs` or any `**/io.cjs` / `**/io` path) and performs no direct `console`, `process.stdout` or `process.stderr` write, and the router cannot import `fs`, `child_process` or `fs/promises` (bare or `node:`), or the shell exec and version-control helpers. Gate config is read through the same dot-path resolver `config-get` uses (`resolveConfigKey`, with `quiet: true`), so a gate sees the configuration `config-get` reports, including `GSD_WORKSTREAM` routing; only nested `workflow.*` keys are honored, and a malformed `config.json` is an absent key with nothing written to stderr. `verify context-drift` and `verify codebase-drift` read their `workflow.*` keys through the same reader.

Behavior differences from the pre-refactor router:

- A top-level `context_coverage_gate` no longer disables the decision-coverage gates, and top-level `auto_advance` / `_auto_chain_active` no longer feed `check auto-mode`; only nested `workflow.*` keys count (#4978).
- Gate config honors `GSD_WORKSTREAM`; the old router read `<project>/.planning/config.json` only.
- `decision-coverage-verify` reads a SUMMARY's `files_modified` from its frontmatter (inline `[a, b]` and block lists); a `files_modified:` block in the body is ignored.
- `tdd-red-evidence` requires the record path to stay inside the project directory and fails as `path escapes its allowed directory: <arg>` otherwise; it used to read any readable path. A record inside the project is reported exactly as before. A relative record path resolves against the process working directory, which every workflow sets to the project directory; invoked from elsewhere, a project-relative path is that same usage failure rather than an `unreadable_record` verdict.
- `tdd-review-checkpoint` asks the evaluation-scope resolver ([Evaluation scope resolver](evaluation-scope.md)) for the plan's commits, so a name such as `x.*` matches nothing instead of satisfying RED or GREEN with an unrelated commit, and a commit on another branch no longer counts. `type: tdd` detection is unchanged (`frontmatterKeyHasValue` is the old `^type:\s*tdd\s*$` test over the frontmatter block).
- Stderr from the version-control calls in `ui-safety-gate`, `tdd-review-checkpoint` and `decision-coverage-verify` is captured instead of leaking to the process stderr (`fatal: not a git repository` on a non-git project).
- `api-coverage-verify-pre` resolves a phase's relative directory against the project directory, not the process working directory.
