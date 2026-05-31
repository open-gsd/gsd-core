---
type: Fixed
pr: 539
---
**UI Design Contract gate no longer silently no-ops in installed projects** — `/gsd-plan-phase` §5.6 and the autonomous workflow now resolve `ui-safety-gate.cjs` against the GSD install dir (`RUNTIME_DIR`) instead of the consuming project's git root, so frontend phases correctly trigger the UI-SPEC prompt.
