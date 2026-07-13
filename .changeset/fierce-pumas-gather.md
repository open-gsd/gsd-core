---
type: Fixed
pr: 2184
---
**The Antigravity reviewer in `/gsd-review` no longer reviews blind** — `agy -p` never granted the agent the repo under review, so it frequently anchored on its own scratch directory and returned plan-text-only verdicts counted at full consensus weight. The reviewer is now granted the repo (capability-probed `--add-dir`) and anchored to the absolute repo root; a review that still runs without repo access is stamped `[reviewed-without-repo-access]` and down-weighted in the Consensus Summary. The cursor-agent prompt gains the same absolute-root anchor. (#2176)
