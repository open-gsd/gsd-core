---
type: Fixed
pr: 6449
---
**A quoted `--ws` value selects its workstream** — `--ws "feature"` and `--ws 'feature'` were ignored by the workstream parse every workflow copies, so the command ran in the active workstream with no message; one pair of quotes around the name is now read like the bare name, and the lines that strip `--ws` from the remaining arguments remove the quoted form too. (#6218)
