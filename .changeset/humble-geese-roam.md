---
type: Changed
pr: 1804
---
**Internal: the model adapter seam exposes `passive` + `active` adapters selected by `modelMode`** — `createModelAdapter({modelMode})` (new `src/model-adapter.cts`): `passive` formalizes today's tier routing (delegates to `model-resolver.resolveModelForTier`), `active` is a host-supplied `sendRequest` seam (VS Code `vscode.lm` / pi providers), fail-closed until Phase 5 binds a concrete provider (ADR-1239 Phase C-1 / #1680 AC3). No user-facing change — the seam is not yet wired to any runtime path.

<!-- docs-exempt: internal adapter seam; no user-facing command/flag/config/schema/doc surface -->
