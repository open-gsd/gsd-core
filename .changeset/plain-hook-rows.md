---
type: Fixed
pr: 6754
---
**The hooks table in `docs/INVENTORY.md` now states which hooks are opt-in** — `gsd-validate-commit.sh`, `gsd-phase-boundary.sh` and `gsd-session-state.sh` do nothing unless `hooks.community` is `true`, the commit validator blocks with exit 2, and the injection scanner covers WebFetch and WebSearch results as well as Read. (#6753)
