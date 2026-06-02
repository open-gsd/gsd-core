---
'@opengsd/get-shit-done': changed
---

ADR-457 build-at-publish: migrate batch 3 modules to TypeScript source (PR #537).

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->

Migrated modules (all `get-shit-done/bin/lib/` → `src/`):

- `observability/event.cjs` → `src/observability/event.cts`
- `workstream-inventory-builder.cjs` → `src/workstream-inventory-builder.cts`
- `plan-scan.cjs` → `src/plan-scan.cts`
- `fallow-runner.cjs` → `src/fallow-runner.cts`
- `project-root.cjs` → `src/project-root.cts`
- `installer-migration-authoring.cjs` → `src/installer-migration-authoring.cts`
- `update-context.cjs` → `src/update-context.cts`
- `installer-migrations/000-first-time-baseline.cjs` → `src/installer-migrations/000-first-time-baseline.cts`
- `runtime-homes.cjs` → `src/runtime-homes.cts`
- `model-catalog.cjs` → `src/model-catalog.cts`
