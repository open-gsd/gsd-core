---
type: Changed
pr: 1090
---

**Antigravity workspace skills now install to the canonical `.agents/` directory** — fresh installs write workspace artifacts under `.agents/` (the Google-Codelabs-documented base) instead of `.agent/`; the legacy `.agent/` layout is still recognized so existing installs keep working. The global `~/.gemini/antigravity/` path is unchanged. (#1090)
