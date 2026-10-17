---
type: Fixed
pr: 5477
---
`phase add` and `phase add-batch` now change only the block they insert: an unrelated heading no longer gains a blank line and a CRLF roadmap stays CRLF. The new phase's `Depends on:` names the nearest lower phase the roadmap actually declares (or `Nothing`) instead of `N-1`, which could be a phase that exists only on another branch, as an orphan directory, or not at all.
