# SDK Package Seam Module owns SDK-to-get-shit-done-redux compatibility

- **Status:** Superseded by ADR-0174 (2026-05-23); originally Accepted (2026-05-07)
- **Date:** 2026-05-07

We decided to define one explicit SDK Package Seam Module for the `@opengsd/gsd-sdk` → `@opengsd/get-shit-done-redux` transition. During this transition, install-layout probing, legacy `gsd-tools.cjs` discovery, legacy `core.cjs` discovery, and compatibility-only missing-asset diagnostics must live behind one seam instead of leaking across SDK Modules. This keeps callers thin, raises leverage for standalone-SDK testing, and improves locality by making package-readiness bugs land in one place. First tracer-bullet slice: add one compatibility Adapter Module at this seam and migrate current legacy asset callers onto it before broader native replacement work.

Runtime-global skills directory resolution is explicitly out of scope for this seam. That policy varies by runtime (`claude`, `codex`, `cline`, etc.) rather than by legacy package/install layout, so it now lives in a separate Runtime-Global Skills Policy Module consumed by `agent-skills` and `skill-manifest`.
