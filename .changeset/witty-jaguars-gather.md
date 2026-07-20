---
type: Fixed
pr: 0
---
**CI gates no longer fail with `no merge base` on branches behind the base.** The mutation, changeset-required, and docs-required workflows shallow-fetched the base *ref*, truncating the ancestry their three-dot `origin/<base>...HEAD` diffs depend on — so the mutation gate reported failure and silently skipped its Stryker shards, leaving the 80% threshold unverified on any PR not already level with `next`. (#2452)
