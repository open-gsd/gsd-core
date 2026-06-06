---
type: Fixed
pr: 151
---
**STATE.md template now includes YAML frontmatter block** — both `get-shit-done/templates/state.md` and `sdk/prompts/templates/state.md` now ship with a `gsd_state_version`, `status`, and zeroed `progress.*` block so freshly initialised `STATE.md` files are immediately readable by frontmatter consumers before the first `state` mutation. Closes #21.
