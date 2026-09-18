---
type: Fixed
pr: 4847
---
**OpenCode installs no longer flag all 72 GSD skills as custom files** — the installer's file manifest now records the skills it stages for OpenCode, matching every other skills-layout runtime, so clean installs report zero custom files. The first update after upgrading may show the custom-files backup prompt once while the manifest catches up; from then on updates run without it. (#4738)
