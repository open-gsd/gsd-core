---
type: Fixed
pr: 1206
---
**Installed runtimes no longer silently disable `verify:post` gates** — in a global skills-runtime install (e.g. Codex at `~/.codex`), the `commands/gsd` source tree is absent, so capability-state resolved an empty skill manifest. The full-profile `*` sentinel then materialized to an empty surfaced set, marking every capability `surfaced=false` → `enabled=false`. The result: `gsd-tools loop render-hooks verify:post` returned `activeHooks: []` even with `security_enforcement` and `nyquist_validation` enabled, so the security and Nyquist gates never fired. Capability-state now falls back to the installed `<configDir>/skills/gsd-*/SKILL.md` layout when the source tree is unreachable, so `verify:post` again includes `security -> secure-phase` and `nyquist -> validate-phase`. (#1206)
