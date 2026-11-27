# Decision coverage gates explained

When `discuss-phase` writes implementation decisions into CONTEXT.md `<decisions>`, two gates ensure those decisions survive the trip into plans and shipped code (issue #2492). The toggle key is `workflow.context_coverage_gate` in [Configuration — Decision Coverage Gates](../CONFIGURATION.md#decision-coverage-gates-workflowcontext_coverage_gate); the standalone invocation of the plan gate is documented there too.

## What the gates do

**Plan-phase translation gate (BLOCKING).** Runs immediately after the
existing requirements coverage gate, before plans are committed. For each
trackable decision in `<decisions>`, it checks that the decision id
(`D-NN`) or its text appears in at least one plan's `must_haves`,
`truths`, or `objective` (front-matter), a `## must_haves`/`truths`/`tasks`/`objective`
heading, or an `<objective>`/`<tasks>`/`<task>`/`<action>`/`<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>`
tag body. A miss surfaces the missing decision by id and refuses
to mark the phase planned.

**Verify-phase validation gate (NON-BLOCKING).** Runs alongside the other
verify steps. Searches every shipped artifact (PLAN.md, SUMMARY.md, files
modified, recent commit subjects) for each trackable decision. Misses are
written to VERIFICATION.md as a warning section but do **not** flip the
overall verification status. The asymmetry is deliberate — by verify time
the work is done, and a fuzzy substring miss should not fail an otherwise
green phase.

## Writing decisions the gates accept

The discuss-phase template already produces `D-NN`-numbered decisions.
The gate is happiest when:

1. Every plan that implements a decision **cites the id** somewhere —
   `must_haves.truths: ["D-12: bit offsets exposed"]` or a `D-12:` mention
   in the plan body. Strict id match is the cheapest, deterministic path.
2. Soft phrase matching is a fallback for paraphrases — if a 6+-word slice
   of the decision text appears verbatim in a plan/summary, it counts.

## Opt-outs

A decision is **not** subject to the gates when any of the following
apply:

- It lives under the `### Claude's Discretion` heading inside `<decisions>`.
- It is tagged `[informational]`, `[folded]`, or `[deferred]` in its
  bullet (e.g., `- **D-08 [informational]:** Naming style for internal
  helpers`).

Use these escape hatches when a decision genuinely doesn't need plan
coverage — implementation discretion, future ideas captured for the
record, or items already deferred to a later phase.

---

## Related

- [Decision Coverage Gates (Configuration)](../CONFIGURATION.md#decision-coverage-gates-workflowcontext_coverage_gate) — the key and the standalone gate invocation
- [The phase loop](the-phase-loop.md) — where discuss, plan and verify sit in the lifecycle
