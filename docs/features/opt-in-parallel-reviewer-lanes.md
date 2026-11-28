---
id: 165
title: Opt-In Parallel Reviewer Lanes
group: v1.7.0 Features
---

**Command:** `/gsd-review`, `/gsd-plan-review-convergence`

**Config key:** `review.parallel_lanes` (default `false`)

**Purpose:** Reviewer lanes within one review pass have no data dependency on each other — they all inspect the same immutable plan snapshot — but were dispatched strictly one at a time, so a pass with Codex, Antigravity and Claude cost roughly the sum of three long reviewer calls. The serialization was a deliberate, unconditional protection against provider rate limits, which made it a global policy imposed on users whose providers could comfortably take concurrent requests, or who run local model servers with no limits at all (#3034).

**Behavior:** With the key enabled, the `invoke_reviewers` step dispatches each selected lane as a background job and joins all of them before `REVIEWS.md` and consensus are rendered. Wall-clock cost falls toward the slowest lane rather than the sum. Default remains `false`, preserving the existing sequential dispatch and its rate-limit protection.

**Guard and ordering.** Only the exact value `true` opts in, and a failure to read the config falls back to sequential. Per-lane results are concatenated in reviewer-selection order after the join, so `gsd-review-lane-results.jsonl` is identical in both modes. Timeouts, prompt budgets, the diagnostic stub for an empty or failed lane, explicit-lane failure ([ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) D4), trust/egress checks and result-file layout are untouched, and a failing lane does not abort its siblings. The reasoning is in [About the code-review pipeline's design choices](../explanation/review-pipeline-design.md#why-parallel-reviewer-lanes-fail-safe-and-keep-sequential-ordering).

**Known limits:** convergence cycles stay sequential by design (`review → replan → re-review` has a genuine data dependency), so this speeds up each pass rather than reducing the number of passes; there is no concurrency bound, so every selected lane dispatches at once; and reviewer instances sharing one adapter dispatch concurrently against that single provider, which is the most likely way to hit a limit.

**Reference:** [Configuration](CONFIGURATION.md#parallel-reviewer-lanes-for-gsd-review-3034) · [Enable parallel reviewer lanes](how-to/enable-parallel-reviewer-lanes.md) · [Commands](COMMANDS.md)
