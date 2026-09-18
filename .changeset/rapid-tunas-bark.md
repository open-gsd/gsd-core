---
type: Fixed
pr: 0
---
**A genuinely installed non-Claude runtime now resolves its own models instead of an empty string** — the per-install runtime identity is materialized into the config, so a marker-detected Codex install resolves its tier map past a shared `resolve_model_ids:"omit"` that was written for Claude protection; Claude resolutions and garbage runtime values behave exactly as before. (#4717)
