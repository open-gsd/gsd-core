---
type: Fixed
pr: 0
---
**A re-run of execute-phase no longer overwrites a UAT file that already holds recorded human results** — when the verifier returned human_needed, Step A recreated NN-UAT.md from the template and committed it; it now merges new items as pending and keeps existing results. (#5845)
