---
type: Changed
pr: 1093
---
**Windsurf/Devin workspace skills now install to the canonical `.devin/skills/` directory** — fresh workspace installs write skills under `.devin/skills/` (Devin Desktop's documented preferred location) instead of `.windsurf/skills/`; the legacy `.windsurf/skills/` layout is still recognized. The global `~/.codeium/windsurf/skills/` path is unchanged. (#1093)
