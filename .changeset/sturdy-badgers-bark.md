---
type: Fixed
pr: 0
---
**OpenCode installs no longer flag all 72 GSD skills as custom files** — the installer's file manifest now records the skills it stages for OpenCode (matching every other skills-layout runtime), so clean installs report zero custom files and updates no longer trigger spurious backup/restore prompts. (#4738)
