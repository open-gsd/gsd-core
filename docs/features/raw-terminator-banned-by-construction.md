---
id: 3910
title: The Raw Terminator Is Banned by Construction
group: v1.7.0 Features
---

**Purpose:** Make a bare `process.exit(...)` a lint error everywhere it matters, so the
"nothing fails with success" defect class ADR-3889 exists to close cannot silently reopen
through a new call site. The reasoning is in
[Why failures are surfaced, not absorbed](../explanation/why-failures-are-surfaced-not-absorbed.md#why-the-raw-terminator-is-banned-by-construction-3910).

**What changed (ADR-3889 Phase 6, #3910):**

- New rule `local/require-registered-exit` (`eslint-rules/require-registered-exit.cjs`) flags
  any `CallExpression` shaped exactly like `process.exit(...)`. It does not flag
  `process.exitCode = N`.
- Registered on four globs: `src/**/*.cts`, `scripts/**/*.cjs`, `hooks/**/*.js`,
  `gsd-core/bin/**/*.cjs` (`eslint.config.mjs:420-426,545-547,574-576,601`).
- The dead `n/no-process-exit: 'off'` carve-out for `hooks/**` is deleted.
- Exactly two allowlist entries, repo-wide: the body of `terminateNow` in `src/cli-exit.cts`
  (detected structurally), and `gsd-core/bin/gsd-tools.cjs`'s `ensureRuntimeBuild`
  bootstrap-failure path via an inline `eslint-disable-next-line`.
- The last raw terminators in `src/**/*.cts` were migrated onto the seam; `src/io.cts`'s
  `error()` now throws a catchable `ExitError(1)` with byte-identical stderr, and
  `command-routing-hub`'s `dispatch()` and the profile-pipeline router were fixed so it
  reaches `runMain`.
- **Known limits (documented and test-pinned, not endorsed):** the rule matches the literal
  `process.exit(...)` shape only. It does not catch `process['exit'](0)`, `const e =
  process.exit; e(1)`, or `process.exit.call(...)`/`.apply(...)`; pinning tests in
  `tests/eslint-rules.test.cjs` assert today's non-detection.

See [Resolve a raw-terminator finding](../how-to/resolve-a-raw-terminator-finding.md) for what to
do when this rule fires, and [ADR-3889](../adr/3889-process-exit-contract.md) for the exit-code
registry the seam is layered over.
