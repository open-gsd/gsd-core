---
type: Fixed
pr: 539
---
**UI Design Contract gate no longer silently no-ops in installed projects** — `/gsd-plan-phase` §5.6 and the autonomous workflow now resolve `ui-safety-gate.cjs` against the GSD install dir (`RUNTIME_DIR`) instead of the consuming project's git root, so frontend phases correctly trigger the UI-SPEC prompt. `ui-safety-gate.cjs` is now also deployed to `gsd-core/bin/lib/` (the path the GSD installer copies to `$RUNTIME_DIR`) and probed there first, ensuring it is found in installed runtimes where root `bin/lib/` is not present.
