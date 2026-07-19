---
type: Added
pr: 2422
---
**`<precondition>` task element (Design by Contract)** — plans may now declare a runnable/checkable fact a task assumes (env var set, prior-phase artifact present, external-setup done) that plan ordering does not guarantee; the executor asserts it before running the task and halts with a checkpoint on unmet instead of building on a broken assumption. Plans that omit `<precondition>` behave exactly as today. (#1949)
