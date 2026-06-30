---
type: Changed
pr: 1802
---
**Internal: the declarative embedding adapter is now named + bound behind a minimal `HostIntegrationInterface`** — `createDeclarativeAdapter({runtime})` (new `src/adapter-declarative.cts`) delegates in-process to `install-engine`'s `installRuntimeArtifacts`/`uninstallRuntimeArtifacts`, formalizing today's projection path as one of the two embedding adapters behind a common contract (ADR-1239 Phase C-1 / #1680 AC1). Output is byte-identical to today's install (gated by `golden-install-parity`). The full 6-point interface binding surface is deferred until the imperative adapter (AC2) fixes the shape (ADR-1239 open wire-shape question). No user-facing change — the adapter is not yet wired to any runtime path.

<!-- docs-exempt: internal adapter infrastructure; no user-facing command/flag/config/schema/doc surface -->
