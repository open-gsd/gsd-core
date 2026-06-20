---
type: Fixed
pr: 1409
---
**Codex runtime no longer crashes on startup** — every `gsd-tools` command previously aborted with `Cannot find module '../../../package.json'` on Codex, whose runtime root has no `package.json`, because a module in the loader chain did a top-level require of it. The version emitted into Hermes skill frontmatter is now sourced lazily from the installed `gsd-core/VERSION` (validated semver), so `gsd-tools` loads on every runtime and never emits `version: undefined`. (#1383)
