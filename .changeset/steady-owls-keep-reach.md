---
type: Fixed
pr: 5810
---
**Two ROADMAP Progress readers read what they read before the Progress owner** — the archive-span scan treats a level-1 `# Progress` heading as a Progress section again, so a collapsed block holding the Progress table stays editable, and the workstream inventory reads a milestone table that sits outside an existing `## Progress` section without a matching table again. Both had changed with the one-owner refactor and now keep their reach without a second locator. (#5692)
