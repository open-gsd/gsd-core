---
type: Added
pr: 4955
---
**`/gsd-health` warns about project skills that make discovery expensive (W030)** — a project skill whose `SKILL.md` has no frontmatter `description` is read in full on every discovery-agent spawn, and one longer than 500 lines (the Agent Skills guideline) is read whole whenever it is relevant. W030 names each such file and how to fix it. GSD's own `gsd-*` skills are not checked. Like any warning it reports health as `degraded`, and it is never auto-fixed. (#4649)
