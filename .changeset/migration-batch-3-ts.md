---
type: Changed
pr: 537
---
Migrate 10 more `get-shit-done/bin/lib` runtime modules to TypeScript sources of truth (ADR-457 build-at-publish, batch 3): event, workstream-inventory-builder, plan-scan, fallow-runner, project-root, installer-migration-authoring, update-context, 000-first-time-baseline, runtime-homes, model-catalog. Each moves to `src/*.cts` (strict TS), compiled by `tsc` to a gitignored `.cjs` at the same `require()` path; behaviour preserved byte-for-behaviour.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
