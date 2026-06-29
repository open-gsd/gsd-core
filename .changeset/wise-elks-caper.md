---
type: Changed
pr: 1806
---
**Internal: external-descriptor trust gate — load-time `configHome` confinement** — `assertDescriptorConfined(descriptor, configHome)` (new `src/external-descriptor-trust.cts`) fail-closed rejects any installed third-party host-plugin descriptor whose declared `destSubpath` resolves outside the user-approved `configHome`, before its install plan runs (ADR-1239 Phase C-2 / #1681 slice 1). Defense-in-depth load-time twin of Phase 2's install-time `assertDestWithinConfigHome`. Not yet wired into the loader (slice 2). No user-facing change.

<!-- docs-exempt: internal security module; no user-facing doc surface until the loader wiring in slice 2 -->
