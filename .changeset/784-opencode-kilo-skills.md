---
type: Added
pr: 810
---
Emit native on-demand skills (`skills/<name>/SKILL.md`) for the OpenCode-family runtimes (OpenCode and Kilo) at install time, in addition to the existing flat `command/` and file-based `agents/` surfaces. OpenCode and Kilo share a config schema and both discover skills from `skills/<name>/SKILL.md`; the installer now stages each GSD command as a skill with minimal, spec-compliant frontmatter (`name` matching the directory, `description` 1–1024 chars) via a shared OpenCode-family skill writer. Skills respect the active install profile (core/minimal stage only their subset) and are removed on uninstall. (#784)
