---
type: Fixed
pr: 0
---
**The artifact registry now names the commands that write `NN-UAT.md`, `NN-VALIDATION.md` and `CLAUDE.md`** — `gsd-core/templates/README.md` credited `/gsd:validate-phase` with the UAT file (it writes `NN-VALIDATION.md`), omitted `/gsd:execute-phase` as a writer of `NN-UAT.md` and `/gsd:plan-phase` as a writer of `NN-VALIDATION.md`, and pointed at `/gsd-profile`, which is not a command. (#6787)
