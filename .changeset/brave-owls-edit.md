---
type: Fixed
pr: 6707
---
**The roadmap agent can now edit roadmap files in place where its own directives say "Edit"** — gsd-roadmapper instructed "(Edit, not rewrite from scratch)" while its tools list withheld Edit, so the directive was unexecutable and whole files got rewritten; both the canonical and compact roadmapper now carry the Edit grant and the Pi mirror is regenerated. (#6508)
