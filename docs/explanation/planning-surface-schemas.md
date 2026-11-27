# Why the planning read surfaces have separate schemas

Two commands expose planning state to outside consumers: `planning inspect`, a pull query, and the `.planning/state.json` state contract, a push artifact. They do not share a schema, and neither serializes the internal `PlanningSnapshot`. What each emits is in [feature 163](../FEATURES.md#163-read-only-planning-snapshot-planning-inspect) and [feature 166](../FEATURES.md#166-machine-readable-state-contract-planningstatejson).

## Why `planning inspect` does not serialize the internal snapshot

`PlanningSnapshot` (the diagnostic-rule subject introduced by ADR-3180 §8.1) is deliberately additive and still growing — four fields at Phase 10, twenty-plus by Phase 12. Handing that shape to external consumers would freeze an internal contract by accident. `planning inspect` declares its own flat schema and maps into it, so a field added to `PlanningSnapshot` never changes what this command emits.

## Why the state contract does not reuse `planning inspect`'s schema

The two surfaces answer different questions and have opposite shapes. `planning inspect` is a rich, diagnostic-carrying **pull** query a consumer runs; this is a small **push** artifact a consumer watches. Publishing `planning inspect`'s payload at every `phase add` would mean opening every plan, summary and requirements document on a hot path, and freezing a much larger surface as a contract.
