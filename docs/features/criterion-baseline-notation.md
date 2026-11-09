---
id: 4309
title: Criterion Baseline Notation
group: v1.43.0 Features
---

**Command:** `gsd-tools verify plan-structure <PLAN.md>` (run by `/gsd-plan-phase`'s plan checker)

**Purpose:** Catch a quantitative acceptance criterion that is already true before any work happens. Such a criterion passes whether or not the task runs, so it verifies nothing. The planner records each count/match gate's measured baseline beside it, and `verify plan-structure` checks that the gate can fail.

**Notation:**

```
[HEAD=<value> EXPECT<op><value> [@<sha>] [GUARD MUTATION: <ref>] [UNPINNED]]
value ∈ <integer> | absent | present | error:<exit-code>      op ∈ == != >= > <= <
```

`HEAD` is what the command prints now, and `EXPECT` is what it must print after the change. A `grep -c` over a missing file is `error:2`, not `0`.

**Behavior:**

| Rule | Severity | Fires when |
|---|---|---|
| B1 | error | `HEAD` already satisfies `EXPECT` and the notation lacks `GUARD MUTATION: <ref>`; the plan is invalid |
| B2 | warning | a legacy free-form `# baseline at HEAD:` comment sits in a criteria zone |

A notation the checker cannot parse or evaluate is a status in `baseline_statuses` and never changes the exit code. Nothing is executed. The JSON verdict adds `baseline_notation_count`, `baseline_findings` and `baseline_statuses`. The exit is `<!-- plan-criteria-allow: B1 - <reason> -->`.

**Reference:** [PLAN.md → Baseline notation](reference/plan-md.md#baseline-notation) · [Resolve baseline-notation findings](how-to/resolve-baseline-notation-findings.md) · [ADR-4309](adr/4309-criterion-baseline-notation.md)
