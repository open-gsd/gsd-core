---
type: Fixed
pr: 1092
---
**Workspace (local) Antigravity and Copilot skill installs no longer point at the global config home** — a local install rewrote `~/.claude/` references in `SKILL.md` bodies to the global `~/.gemini/antigravity/` / `~/.copilot/` paths instead of the workspace-relative `.agent/` / `.github/`, because the skills layout wrapper passed the runtime name into the converter's `isGlobal` parameter slot. (#1092)
