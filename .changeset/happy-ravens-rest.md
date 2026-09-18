---
type: Fixed
pr: 4842
---
**Markdown writes no longer insert a blank line between a paragraph and a following list** — every .md write re-normalized the whole document and split tight paragraph→list transitions, reflowing prose the command never touched (e.g. `roadmap.update-plan-progress` editing unrelated phase-section prose). Tight lists now stay byte-identical on disk. (#4725)
