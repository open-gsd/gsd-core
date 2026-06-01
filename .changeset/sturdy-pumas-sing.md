---
type: Fixed
pr: 571
---
gsd-doc-writer fix mode now uses the Edit tool for surgical corrections instead of Write. Previously, the fix_loop in docs-update.md could call gsd-doc-writer in fix mode with Write, truncating an untracked doc to a single line with no git recovery path. Adds a post-fix line-count guard in fix_loop that restores from pre-fix content if >90% shrinkage is detected.
