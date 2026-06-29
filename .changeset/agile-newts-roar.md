---
type: Changed
pr: 1813
---
**Internal: the installer's `program` (display-name) + `command` (slash-invocation) chains are now single-source lookups** — the 14-line `program` chain (an exact duplicate of `runtimeLabel`) → `getRuntimeLabel`, and the 14-line `command` chain (the per-runtime `/gsd-new-project` syntax: gemini `/gsd:`, codex `$`, cursor skill-mention, kimi `/skill:`, default `/gsd-new-project`) → new `getRuntimeNewProjectCommand(runtime)` helper (ADR-1239 Phase B / #1679 AC2 slice 4). `runtime ===` count in `bin/install.js`: 53 → 25 (cumulative this session: 129 → 25). Stdout strings preserved byte-for-byte; no install-output change (golden-parity 16/16). No user-facing change.

<!-- docs-exempt: internal refactor; no user-facing doc surface -->
