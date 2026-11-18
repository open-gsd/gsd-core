---
type: Changed
pr: 5540
---
**A gate command now reads the phase from `GSD_PHASE_NUMBER`, `GSD_PHASE_DIR` and `GSD_PHASE_REQ_IDS` instead of a pasted `${PHASE_*}` text** — before, `'${PHASE_NUMBER}'` was rewritten into the command; now that spelling and any placeholder not in plain double quotes make the gate unevaluable, so change it to `"${GSD_PHASE_NUMBER}"`.
