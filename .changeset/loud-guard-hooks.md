---
type: Fixed
pr: 2327
---
**Kilo installs now stage the shared PreToolUse guard hooks the native plugin spawns** — Kilo's capability descriptor declared both a `nativePlugin` (which spawns `gsd-prompt-guard`, `gsd-read-guard`, and `gsd-worktree-path-guard` as subprocesses) and `skipSharedHooksInstall: true` (which suppressed staging those scripts into the Kilo config dir), so every guard silently no-opped on every Kilo install. The skip flag is removed (Kilo now stages the same hooks bundle as OpenCode, whose byte-identical plugin was unaffected), and the plugin's `runHook` now warns loudly — once per hook file — when a guard script is missing instead of treating the absence as a silent allow. Resolves #2305.
