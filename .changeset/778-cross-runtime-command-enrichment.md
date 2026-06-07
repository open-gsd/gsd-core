---
type: Added
pr: 0
---
Cross-runtime command enrichment in the installer. Gemini CLI commands now use native `{{args}}` interpolation (translated from Claude's `$ARGUMENTS`) so typed arguments interpolate into the prompt body, and `/gsd:progress` injects live project state via a fixed, injection-safe `!{cat .planning/STATE.md 2>/dev/null}` shell block. Qwen Code skills now carry a numeric `priority` field so the most-used main-loop workflows (`new-project`, `plan-phase`, `execute-phase`, …) surface first in the `/skills` list. The OpenCode per-command `model`/`agent`/`subtask` enrichment was evaluated and intentionally not implemented — `model` would reintroduce the ProviderModelNotFoundError regression that the converter deliberately guards against for non-Anthropic providers (#1156), `subtask`/`agent` change execution semantics for GSD's interactive commands, and `variant` is not in the OpenCode command schema. (#778)
