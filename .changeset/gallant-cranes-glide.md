---
type: Fixed
pr: 6817
---
**`/gsd-review` writes its reviewer-lane plan again** — the review workflow passed `--json` to `review-lane plan`, which has refused undeclared flags since #6087, so the step exited 1 and left `gsd-review-lanes.json` empty; the workflow and the two docs examples now call `review-lane plan` without it, and a static check fails when shipped Markdown passes a `review-lane` sub a flag the CLI does not declare for it. (#6713)
