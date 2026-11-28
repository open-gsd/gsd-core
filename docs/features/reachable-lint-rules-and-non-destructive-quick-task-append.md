---
id: 3951
title: Reachable Lint Rules and a Non-Destructive Quick-Task Append
group: v1.7.0 Features
---

**Purpose:** Make two ESLint rules cover the code they were written to govern, and stop
`quick-tasks-append` from overwriting curated `progress.*` values on a body-only write. The
reasoning is in
[Why failures are surfaced, not absorbed](../explanation/why-failures-are-surfaced-not-absorbed.md#why-two-lint-rules-had-to-reach-their-whole-surface-3951).

**What changed:**

- `local/no-adhoc-markdown-parsing` no longer gates on its own filename, so it reaches the 28
  `.cts` files in `src/` subdirectories and now also covers `tests/**` and `scripts/**` (80
  parses in 43 test files: 70 routed through `markdown-sectionizer` / `markdown-table`, 10
  suppressed with a stated reason). A test pins that the gate and the registration agree in
  both directions.
- `local/no-adhoc-regex-escape` inspects `MemberExpression`, with an exemption keyed strictly
  on the property being `source` (18 sites) plus `_SOURCE` provenance exemptions (3 sites).
- `quick-tasks-append` accepts optional `--quick-id`, `--slug` and `--directory` to emit the
  canonical row; omitted, the row is byte-identical to before.
- A body-only append passes `{ resync: false }`, so it no longer re-derives `progress.*`.
- `tests/config-field-docs.test.cjs` now reads the **Default** column for
  `workflow.subagent_timeout`, so the guard against the old seconds-based default can fail.

**Known limits:**

- #3426 and #3239 are not closed: their scans in `tests/package-legitimacy-gate.test.cjs`
  need new detectors.
- The 10 suppressions are suppressions, not fixes; each names why the raw markdown text is
  the subject of that assertion.
