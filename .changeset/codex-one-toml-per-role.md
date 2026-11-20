---
type: Fixed
pr: 6426
---
**Codex install writes one agent `.toml` per role from the canonical source** — the Codex emit no longer renders the `gsd-*.compact.md` alternates, which share their canonical sibling's role name and silently overwrote it in directory order, the install reports the real role count instead of one inflated by 29, and two sources naming one role now fail the install instead of one replacing the other. (#6158)
