---
type: Fixed
pr: 0
---
**The npm-audit gate no longer blames a PR for advisories that `next` introduced** — on pull_request runs the audit baseline was pinned to `pull_request.base.sha`, which can be older than the base commit the merge ref contains, so a package `next` itself made vulnerable read as introduced by the PR. The baseline now advances to the newest base commit the tested tree contains, with the pin as its floor. (#5897)
