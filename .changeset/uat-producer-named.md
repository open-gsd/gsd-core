---
type: Fixed
pr: 0
---
**The artifact registry now names every command that produces `NN-UAT.md`, `NN-VALIDATION.md` and `CLAUDE.md`** — `gsd-core/templates/README.md` credited `/gsd:validate-phase` with the UAT file (it writes `NN-VALIDATION.md`), left out `/gsd:execute-phase` and `/gsd:validate-phase` from the files they create, and pointed at `/gsd-profile`, which is not a command. (#6787)
