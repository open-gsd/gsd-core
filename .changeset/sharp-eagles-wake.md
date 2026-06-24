---
type: Fixed
pr: 1653
---
**Non-Claude installs no longer rewrite an explicit `resolve_model_ids: true` to "omit"** — Codex, OpenCode, Gemini, and the other non-Claude runtimes were silently clobbering the deliberate opt-in to full materialized model IDs on every install/upgrade, so generated agent manifests inherited the active chat model instead of pinning the resolved model. The finish step now only defaults `resolve_model_ids` to "omit" when it is absent or falsy; an explicit `true` is preserved. (#1569)
