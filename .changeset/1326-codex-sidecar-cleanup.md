---
type: Fixed
pr: 1360
---

**Codex skills no longer show up twice in autocomplete** — GSD's Codex install wrote an `agents/openai.yaml` sidecar under every managed `gsd-*` skill directory, and recent Codex builds index both `SKILL.md` and the sidecar, so each skill appeared twice (once as `gsd-foo`, once as a humanized `foo` display name). The installer now stops emitting these sidecars and removes stale ones left by prior installs (pruning the empty `agents/` directory), while preserving user-owned skill directories. Codex discovers GSD skills via `SKILL.md` alone. (#1326)
