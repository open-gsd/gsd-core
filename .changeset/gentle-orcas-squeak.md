---
type: Fixed
pr: 0
---
**`GSD_RUNTIME` and the install marker now recognise pi, vscode and zcode** — the runtime name policy did not list these three registered runtimes, so an install naming one of them resolved with no runtime identity, and under `resolve_model_ids: "omit"` pi lost its own tier map. (#3703)
