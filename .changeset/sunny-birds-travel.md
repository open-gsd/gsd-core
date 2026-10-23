---
type: Fixed
pr: 5633
---
**The Claude Code plugin no longer registers every GSD workflow twice** — with no `commands` key Claude Code scanned the nested `commands/gsd/` and listed each workflow again as `gsd:<stem>` next to `gsd-<stem>` (144 entries instead of 72). `plugin.json` now declares `"commands": []`; the `/gsd-core:gsd-<stem>` skill names are unchanged. (#5504)
