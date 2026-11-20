---
type: Changed
pr: 6286
---
**`/gsd-review` flags an Antigravity review that did not read every plan** — `agy` can exit 0 with a normal-looking review after reading only part of its prompt, or after compacting its context and reviewing from its own summary. The Antigravity lane now asks agy to restate each plan's requirements, wave, depends_on and task count, and stamps its review `[incomplete-read]` (with a `read_check` block in REVIEWS.md) when a restatement is missing or wrong, the output was truncated, or agy compacted its context before writing the review. Only plan files inside the repository, of at most 1 MiB, are read for the comparison. The marker is an evidence-quality discount marker at the `/gsd-plan-review-convergence` consensus gate, like `[reviewed-without-repo-access]` (#5491).
