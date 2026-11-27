---
id: 3997
title: Review-Prompt Capability Contributions
group: v1.23.0 Features
---

**Purpose:** An enabled capability's constraints reach the external reviewers `/gsd-review` invokes, the way they already reach the planner, checker, executor and verifier. Without it, the plan can obey a capability's guidance while reviewers judge it without that guidance and recommend changes that conflict with it.

**Seam:** A thirteenth loop point, `review:pre`, publishes the `reviewer` role. `/gsd-review` renders the point once while assembling the shared reviewer prompt and appends every active, runtime-compatible `contribution` addressed `into: reviewer` inside one `<capability_reviewer_rules>` block. Every prompt-bearing lane receives the same block exactly once; a lane with `promptChannel: none` is unchanged; `/gsd-plan-review-convergence` inherits it through its existing `/gsd-review` calls.

**Requirements:**
- REQ-REVIEW-PRE-01: `loop render-hooks review:pre --raw` resolves; the point is part of the generated host contract.
- REQ-REVIEW-PRE-02: Only `kind: "contribution"` entries with `into: "reviewer"` and an inline fragment are inserted, in registry order; disabled, inactive and incompatible capabilities are excluded.
- REQ-REVIEW-PRE-03: With no matching contribution the shared prompt is byte-identical and the step is silent.
- REQ-REVIEW-PRE-04: The block counts toward each lane's prompt cap; an over-cap lane is refused (`prompt_exceeds_context`), never trimmed.
- REQ-REVIEW-PRE-05: A capability declaring a hook at `review:pre` must declare an `engines.gsd` range that excludes older cores; the registry build enforces it.
- REQ-REVIEW-PRE-06: The install summary discloses the contribution by point and target as an instruction surface and names the cross-capability egress; the v1 disclosure signature is unchanged.

**Out of scope:** reviewer selection, lane descriptors and consent, the `REVIEWS.md` format, and any first-party capability shipping a reviewer contribution.

See [ADR-3997](../adr/3997-review-prompt-capability-contributions.md), the [capability manifest reference](../reference/capability-manifest.md#review-pre--reviewer-contributions-3997) and the [trust model](../explanation/capability-trust-model.md#reviewer-contributions-cross-the-external-review-boundary).
