---
type: Fixed
pr: 2051
---
**`capability state` and `loop render-hooks` now accept `--runtime` to override the auto-detected runtime** — previously both commands parsed only `--config-dir`, so the runtime config dir was derived from the persisted `.planning/config.json` runtime (precedence `GSD_RUNTIME` → `config.runtime` → `claude`). A repo that persisted `runtime:"codex"` resolved the config dir to `~/.codex`, where the Claude skill isn't installed, so every skill-bearing capability reported `surfaced:false` and `execute:post`/`verify:post` hooks silently no-op'd when the operator drove GSD from Claude Code. `--runtime <r>` (canonicalized, so aliases like `codex-app` work) now bypasses that fallback so the config dir resolves to the explicitly-named runtime's home. Behavior without the flag is unchanged. (#2003)
