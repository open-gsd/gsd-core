---
type: Changed
pr: 1803
---
**Internal: the imperative embedding adapter now composes the capability registry behind the same `HostIntegrationInterface`** — `createImperativeAdapter({runtime})` (new `src/adapter-imperative.cts`) calls `loadRegistry({includeInstalled:true})` (first-party-wins + consent + fail-closed — identical trust semantics to the CLI) and binds the engine surface behind the same contract the declarative adapter (AC1) satisfies, plus a `registry` accessor for an in-process host to bind its primitives to (ADR-1239 Phase C-1 / #1680 AC2). Concrete host binding is deferred to Phase 5. No user-facing change — the adapter is not yet wired to any runtime path.

<!-- docs-exempt: internal adapter infrastructure; no user-facing command/flag/config/schema/doc surface -->
