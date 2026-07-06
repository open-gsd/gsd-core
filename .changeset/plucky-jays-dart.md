---
type: Changed
pr: 2040
---
**`/gsd:surface` and `--materialize` now produce byte-identical agent output to a fresh install** — surface-path agents for descriptor-driven runtimes (cursor, windsurf, augment, trae, codebuddy, copilot, antigravity) now receive the same path-prefix rewrite, Co-Authored-By attribution, runtime-specific conversion, and body normalization as the install path. Copilot and Antigravity agents are now installed via the descriptor-driven path (copilot agents get the `.agent.md` filename rename). Cline remains on the inline loop (rules-only local branch). (#1575)
