---
type: Changed
pr: 537
---
Migrate 2 modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `config` and `profile-output`. Each `src/<m>.cts` compiles to a gitignored `gsd-core/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added. Note: `cmdMigrateConfig` async dropped (migrateOnDisk is synchronous; caller's `await` is safe on a sync return value).

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
