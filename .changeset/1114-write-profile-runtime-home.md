---
type: Fixed
pr: 1119
---
**`write-profile` now writes `USER-PROFILE.md` to the active runtime's config home instead of always `~/.claude`** — under Codex, `gsd-tools query write-profile` wrote `~/.claude/gsd-core/USER-PROFILE.md` while Codex `discuss-phase` advisor-mode (installed under `~/.codex`) checked the Codex home and never found it, so advisor-mode silently stayed disabled. The default output path is now resolved via the runtime-aware `getGlobalConfigDir` (`GSD_RUNTIME` / `config.runtime` → e.g. `~/.codex` for Codex), matching how the runtime's own workflows resolve it — mirroring `generate-dev-preferences`. Claude is unchanged (`~/.claude`); an explicit `--output` still wins. (#1114)
