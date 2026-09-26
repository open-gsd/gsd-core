---
type: Fixed
pr: 4991
---
**`check decision-coverage-plan` no longer reports `covered: 0` when the phase-dir argument is not a directory.** Passing the phase number (e.g. `01`) where the phase directory belongs loaded zero plans, and the gate then listed every decision as uncovered, which looked exactly like a real coverage gap. Both decision-coverage gates now answer `reason: "phase directory not found"` and name the argument: the plan gate still fails closed, with `total`/`covered` null instead of a measured-looking zero, and the verify gate returns a non-blocking warning with no decision reported not-honored. Calling the plan gate with no phase-dir argument behaves as before. (#4939)
