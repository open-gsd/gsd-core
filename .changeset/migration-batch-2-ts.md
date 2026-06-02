---
type: Changed
pr: 537
---
Migrate 10 modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `installer-migration-report` (Group A), `prompt-budget` (Group A), `secrets` (Group B), `phase-lifecycle` (Group B), `workstream-name-policy` (Group B), `decisions` (Group B), `validate` (Group B), `schema-detect` (Group B), `runtime-name-policy` (Group C), and `runtime-slash` (Group C — first cross-module TS import, depends on `runtime-name-policy`). Each `src/<m>.cts` compiles to a gitignored `gsd-core/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added. Group B entries removed from `tsconfig.lint.json` excludes now that they are first-class TypeScript.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
