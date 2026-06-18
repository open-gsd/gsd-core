---
type: Changed
pr: 1438
---
**Descriptor-driven install path now applies per-runtime agent conversion** for copilot/antigravity/cursor/windsurf/augment/trae/codebuddy/cline — their extracted agent converters (from #1099) are wired into the descriptor's `agents` kind, with install scope threaded for the scope-aware copilot/antigravity converters. Internal install-path parity step (ADR-1235 cutover); the legacy install loop remains authoritative so installed output is unchanged. (#1173)

<!-- docs-exempt: internal install-path wiring (ADR-1235 cutover); the legacy loop remains authoritative so installed agent output is unchanged — no user-facing command/config/behavior surface. -->
