---
type: Changed
pr: 1808
---
**Internal: third-party descriptor loader enforces `configHome` write-confinement at load time** — `loadRegistry({includeInstalled:true, configHome})` now rejects (skip + warn, fail-closed) any installed third-party host-plugin descriptor whose declared `destSubpath` resolves outside the supplied `configHome`, before it is composed into the registry (ADR-1239 Phase C-2 / #1681 slice 2). The `configHome` option is optional and backward-compatible (omitted → no load-time check; install-time gate still bounds writes). No user-facing change for existing flows.

<!-- docs-exempt: internal loader hardening; no user-facing doc surface until slice 3's MCP server -->
