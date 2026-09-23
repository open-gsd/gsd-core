---
type: Fixed
pr: 4892
---
**run-with-timeout works from project paths containing spaces on Windows** — the .cmd/.bat mediation quoted the shim path and cmd.exe /s stripped the wrong quotes, so every mediated call under a spaced project path failed with exit 1 and empty stdout (the /gsd-code-review fallow pre-pass included); the mediation now uses the same projectSpawnInvocation seam as every other Windows spawn site. (#4797)
