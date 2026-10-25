---
type: Fixed
pr: 5667
---
**The post-wave UI safety gate no longer halts a project with no frontend** — `check ui-safety-gate` now requires the same static frontend evidence as `check ui-plan-gate` (a component file, a UI-framework dependency, or native UI imports) before it blocks, so a stray `.html` fixture or a Python file under a `ui/` directory in a backend project no longer demands a UI-SPEC. Evidence that cannot be read is reported as unreadable, never as a pass. (#5646)
