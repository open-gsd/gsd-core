---
type: Fixed
pr: 2332
---
**Installing a non-Claude runtime no longer breaks Claude's model resolution in no-project sessions** — the installer writes `resolve_model_ids:"omit"` for non-alias runtimes into the machine-wide `~/.gsd/defaults.json`, which any runtime read back, so install order silently flipped Claude's adaptive tier aliases (executor→sonnet, planner→opus) to an empty model string. Resolution is now scoped to the runtime actually resolving, via a per-install `.gsd-runtime` marker: Claude ignores a global-defaults omit and keeps its tier aliases, non-alias runtimes still omit, and an explicit project-level `omit`/`true` is always honored. (#2297)
