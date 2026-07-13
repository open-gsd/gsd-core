---
type: Fixed
pr: 2228
---
**Bullet/em-dash ROADMAP phases no longer resolve to `Phase null`** — the roadmap phase lookup matched only ATX headings with a colon, so a bullet entry like `- [ ] **Phase N — Name**` (which the roadmapper emits) failed to resolve and `Phase null` landed in STATE.md; a bullet-only ROADMAP also broke the milestone phase count. Phase lookup and the milestone filter now accept bullet/checkbox entries with an em-dash/en-dash/hyphen/colon separator. (#2199)
