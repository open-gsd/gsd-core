---
type: Fixed
pr: 1631
---
**Windsurf reinstall removes legacy .devin/skills/ artifacts** — pre-#1615 installs wrote skills under .devin/skills/gsd-*/ (Devin Desktop layout, #1085). #1615 moved Windsurf to .windsurf/workflows/ but never cleaned up the old layout. Reinstalls now remove GSD-managed .devin/skills/gsd-* dirs; user-owned content is preserved.
