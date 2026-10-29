---
type: Fixed
pr: 0
---
**Two ROADMAP Progress readers read what they read before the Progress owner** — the archive-span scan treats a level-1 `# Progress` heading as a Progress section again, so a collapsed block holding the Progress table stays editable, and the workstream inventory reads a milestone table that sits outside an existing, table-less `## Progress` section again. Both had changed with the one-owner refactor; the owner now takes a `levels` and a `sectionMiss` option so the two readers keep their reach without a second locator. (#5692)
