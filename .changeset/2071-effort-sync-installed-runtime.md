---
type: Fixed
pr: 2076
---
**`gsd-tools effort sync` no longer crashes in an installed runtime.** In any global install (e.g. `~/.claude/gsd-core/`), `effort sync` threw `Cannot find module '../../../bin/install.js'` — the command reached into the package-root `bin/install.js` for its install-time effort resolvers, but the installer only copies the `gsd-core/` subtree into a runtime home, so that file is never present there. As a result, `effort` config changes (`routing_tier_defaults` / `agent_overrides`) silently never reached installed agents without a full reinstall. The two resolvers (`readGsdEffectiveEffortConfig` + `resolveInstallTimeEffort`, with their helpers) are now extracted into a shipped `gsd-core/bin/lib/install-effort-resolver.cjs` that both `effort sync` and the installer import — a single source of truth that is always present in the installed tree. (#2076)
