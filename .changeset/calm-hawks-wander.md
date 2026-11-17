---
type: Fixed
pr: 6254
---
**The branch-protection guide now documents the Actions event policy that `pull_request_target` needs** — GitHub enforces its default block on that event on December 2, 2026 and blocked it in scheduled windows before then, which left the three required PR checks unreported and kept PRs out of the merge queue. The new section gives the symptom, why the workflows are not changed, the policy payload and how to recover a PR. (#6253)
