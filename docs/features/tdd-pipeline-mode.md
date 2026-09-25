---
id: 116
title: TDD Pipeline Mode
group: v1.36.0 Features
---

**Purpose:** Opt-in TDD (red-green-refactor) as a first-class phase execution mode. When enabled, the planner aggressively selects `type: tdd` for eligible tasks and the executor enforces RED/GREEN/REFACTOR gate sequence with fail-fast on unexpected GREEN before RED.

**Requirements:**
- REQ-TDD-01: `workflow.tdd_mode` config key (boolean, default `false`)
- REQ-TDD-02: When enabled, planner applies TDD heuristics from `references/tdd.md` to all eligible tasks (business logic, APIs, validations, algorithms, state machines)
- REQ-TDD-03: Executor enforces gate sequence for `type: tdd` plans — RED commit (`test(...)`) must precede GREEN commit (`feat(...)`)
- REQ-TDD-04: Executor fails fast if tests pass unexpectedly during RED phase (feature already exists or test is wrong)
- REQ-TDD-05: End-of-phase collaborative review checkpoint verifies gate compliance across all TDD plans (advisory, non-blocking)
- REQ-TDD-06: Gate violations surfaced in SUMMARY.md under `## TDD Gate Compliance` section

**Configuration:** `workflow.tdd_mode`
**Reference files:** `tdd.md`, `checkpoints.md`

#### RED evidence formats

`check tdd-red-evidence` selects a parser by the captured report format. Node's
built-in runner and Vitest (`tap` and `tap-flat`) share the TAP adapter; Maven
Surefire and Failsafe share the JUnit XML adapter. The command name does not
select or bypass validation. Reports from other producers can use these same
formats. Unsupported or malformed reports return `INVALID_RED` with
`evidence.report_errors`; configure a supported reporter before proceeding.

`src/report-parser.cts` owns the adapters and their common result contract:
individual test identities, optional class groups, pass/fail/skip/TODO statuses,
and report validity. A new format needs an adapter and regression evidence;
the RED policy in `src/tdd-red-evidence.cts` stays independent of the format.
No runner-specific TAP summary counters are required.

The gate rejects incomplete plans/documents, bailouts, skipped/TODO targets,
and ambiguous names. Qualify repeated TAP names with their suite path, and
repeated JUnit class names with their package. Evidence counts are individual
test cases, excluding suite-closing TAP points. `evidence.matched_test` and the
persisted `failing_test` identify the target failure rather than an unrelated
first failure. Report freshness and whether the assertion tests the intended
behavior still require executor inspection; the parser cannot establish them.

The upstream parsers (`tap-parser` and `saxes`) ship as reproducible bundles,
including license notices, so installed runtimes need no `node_modules`.
