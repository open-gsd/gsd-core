---
type: Changed
pr: 537
---
Migrate 9 pure leaf modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `context-utilization`, `artifacts`, `command-arg-projection`, `clock`, `ui-safety-gate`, `review-reviewer-selection`, `clusters`, `installer-migrations/001-legacy-orphan-files`, and `observability/redaction`. Each `src/<m>.cts` compiles to a gitignored `gsd-core/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only types are added. A minimal `src/node-globals.d.ts` ambient declaration covers `process`, `require`, and `module` globals for modules that use them (since `"types": []` is set in `tsconfig.build.json`).

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; hand-written .cjs collapsed to TS sources compiled to behaviourally-identical gitignored artifacts at the same require() paths. No user-facing change. -->
