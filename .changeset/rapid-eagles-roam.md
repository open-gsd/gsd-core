---
type: Fixed
pr: 4713
---
**Repeated reviews no longer overwrite each other's preserved evidence** — a second review of the same phase silently replaced the first run's lane reports and error stubs in `.review-diagnostics/`, because the copy used each file's lane-named basename and a lane slug is stable across runs. Each run's evidence now lands in its own subdirectory, named after that run, so repeat reviews accumulate diagnostics instead of clobbering them. (#4351)
