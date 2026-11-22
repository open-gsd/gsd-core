---
type: Fixed
pr: 6491
---
**`/gsd-phase --insert` records the typed description in the roadmap-evolution note without running it** — the state-update step passed the description to `state.add-roadmap-evolution --note` as model-filled text inside shell double quotes, so `$(...)`, backticks or a stray `"` in a description were executed or broke the command after the insert had already run; the step now takes the description and after-phase from the typed arguments and passes them as variables, and both state verbs forward `--ws` (it was unset in those fences). (#6195)
