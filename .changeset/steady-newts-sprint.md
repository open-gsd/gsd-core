---
type: Fixed
pr: 4933
---
**ROADMAP.md's `**Plans:**` line no longer drops hand-written trailing notes when a phase completes.** Both writers of the Plans field — `phase complete` and `roadmap update-plan-progress` — now go through the parse -> mutate -> serialize seam ADR-4910 locks instead of their own regexes, so a phase-complete count bump can no longer replace-to-end-of-line and silently drop a trailing human annotation, and both writers now treat a fresh-template placeholder, a real count, and freeform/bracketed prose identically. (#4852)
