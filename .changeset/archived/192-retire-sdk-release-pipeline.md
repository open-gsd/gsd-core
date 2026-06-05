---
type: Fixed
pr: 192
---
Retired the SDK release pipeline by deleting `release-sdk.yml`, removing SDK-specific steps from release/hotfix/install-smoke workflows, deleting obsolete SDK tarball verification artifacts, and removing dead release-sdk regression suites.
<!-- docs-exempt: internal CI/workflow and test cleanup only; no user-facing command or behavior changes -->
