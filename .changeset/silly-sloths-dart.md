---
type: Fixed
pr: 2375
---
**Managed hooks no longer break after a volta node upgrade or prune** — on machines using volta to manage Node, the installer baked a version-pinned node path into every managed hook command. Once volta pruned that node version, every hook failed to spawn with `No such file or directory` at the start of each session, until the installer was re-run. Hook commands now resolve through volta's stable shim, which survives version changes. (#2335)
