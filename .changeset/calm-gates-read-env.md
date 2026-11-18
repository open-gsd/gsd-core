---
type: Changed
pr: 5540
---
**A gate command now reads the phase from `GSD_PHASE_NUMBER`, `GSD_PHASE_DIR` and `GSD_PHASE_REQ_IDS` instead of a pasted `${PHASE_*}` text** — before, `'${PHASE_NUMBER}'` was rewritten into the command; now that spelling and any placeholder not in plain double quotes make the gate unevaluable, so change it to `"${GSD_PHASE_NUMBER}"`; a double-quoted placeholder inside the text that `eval`, `trap` or `sh -c` parses again, and any placeholder in a gate that runs `xargs` without `-0`, `-d`, `--null` or `--delimiter`, are unevaluable too, so pass the value as an argument or read the variable in single-quoted text. (#5482)
