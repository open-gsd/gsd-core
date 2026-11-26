---
type: Added
pr: 6744
---
**`/gsd-health` warns about project skills that defeat the scoped discovery read (W033)** — a skill in `.claude/skills/` or `.agents/skills/` with no frontmatter `description` is read in full on every agent spawn, and a `SKILL.md` over 500 lines is loaded in full whenever it is relevant. Health now names each such skill, the cause and the fix. (#0)
