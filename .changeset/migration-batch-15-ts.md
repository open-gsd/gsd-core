---
type: Changed
pr: 537
---
Migrate 3 modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `phase` (~1608 LOC, 11 exported functions including `cmdPhasesList`, `cmdPhaseAdd`, `cmdPhaseInsert`, `cmdPhaseRemove`, `cmdPhaseComplete`, `computeDependencyLevels`, etc.), `verify` (~1615 LOC, 12 exported functions including `cmdValidateHealth`, `cmdValidateConsistency`, `cmdVerifyCodebaseDrift`, `cmdVerifySchemaDrift`, `cmdValidateAgents`, etc.), and `init` (~2113 LOC, 20 exported functions including `cmdInitExecutePhase`, `cmdInitPlanPhase`, `cmdInitManager`, `cmdInitProgress`, `cmdAgentSkills`, `buildSkillManifest`, etc.). Also adds `src/package-identity.d.cts` declaration file for the permanently hand-written `package-identity.cjs` module so strict `.cts` sources can import it under nodenext moduleResolution. Each `src/<m>.cts` compiles to a gitignored `gsd-core/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
