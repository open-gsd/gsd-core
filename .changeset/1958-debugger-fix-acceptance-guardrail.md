---
type: Added
pr: 2396
---
**`gsd-debugger` now guards fix acceptance with a multi-signal anti-overfitting gate** — a fix that greens the target test can no longer be silently accepted. The debugger now runs a five-signal guardrail before accepting a fix (target test, mutation check via Stryker, no-op/behavior-deleting diff detector, adjacent/held-out tests, and revert-and-reconfirm), degrades gracefully when Stryker or a test suite is absent (each skip is logged, never a silent pass), records every signal's result under `Resolution.verification` in the debug file, and returns a `FIX REJECTED BY GUARDRAIL` outcome that `gsd-debug-session-manager` surfaces for revise / accept-as-documented-debt / abandon. Full rules live in `gsd-core/references/debugger-fix-acceptance.md`. (#1958)
