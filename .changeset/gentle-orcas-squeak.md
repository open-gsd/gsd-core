---
type: Fixed
pr: 6217
---
**pi, vscode and zcode are now recognised as the install's runtime identity** — the runtime name policy did not list these three registered runtimes, so `GSD_RUNTIME` or the install marker naming one of them never set `runtime` in the loaded config, and under `resolve_model_ids: "omit"` pi lost its own tier map. (#3703)
