---
type: Fixed
pr: 1260
---
**`state planned-phase` now advances the pipe-table `Status` cell (and frontmatter `status`), and `state begin-phase` now updates the Current Position `| Phase |` / `| Plan |` cells instead of prepending stray inline lines.** Systemic follow-up to #1255: `planned-phase` ran its body-field replacements on the full file content, so the YAML frontmatter `status:` line was matched before the body `| Status | … |` cell and the status never reached `Ready to execute`; and `begin-phase` had pipe-table branches only for `Status`/`Last activity`, so for pipe-table `STATE.md` the `Phase`/`Plan` rows were left stale while a spurious inline `Phase: N — EXECUTING` line was prepended. Both handlers now strip frontmatter before body-field replacement and update pipe-table cells in place, matching the inline-format behaviour. (#1257)
