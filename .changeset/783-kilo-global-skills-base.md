---
type: Fixed
pr: 806
---
**`getGlobalSkillsBase('kilo')` now resolves to `~/.kilo/skills`** — where Kilo Code actually discovers global skills — instead of `~/.config/kilo/skills`. Per [Kilo Code docs](https://kilo.ai/docs/customize/skills), global skills live in the `.kilo` directory within HOME (`~/.kilo/skills/`), independent of the XDG-based config dir at `~/.config/kilo`. The kilo.jsonc config dir (`~/.config/kilo`) and the `command/` path used by the installer are correct and unchanged. Blast radius: this corrects the resolved skills-base path used by doctor/status checks and agent-skills-block resolution (`init.cjs`); the installer writes commands (not skills) for Kilo, so no files were previously being written to the wrong location.

<!-- docs-exempt: internal path-resolution correction; no user-facing how-to surface changed -->
