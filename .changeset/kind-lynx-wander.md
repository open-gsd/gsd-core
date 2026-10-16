---
type: Fixed
pr: 5459
---
`/gsd-ship` now pushes the CI-recovery commit for a `[ci skip]` ship-note head with no checks even while the PR is awaiting review, so a repo that requires an approval plus status checks no longer wedges (#4993)
