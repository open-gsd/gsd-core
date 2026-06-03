---
type: Changed
pr: 537
---
Finalize the ADR-457 `bin/lib` TypeScript migration (#537): retire the `tsconfig.lint.json` `checkJs` stopgap now that every hand-written `bin/lib/*.cjs` has been collapsed to a `src/*.cts` source of truth, and treat the tsc-generated `config-types.cjs` as a gitignored build artifact like the rest. `package-identity.cjs` remains value-baked (declared via `src/package-identity.d.cts`).

<!-- docs-exempt: Internal ADR-457 build-at-publish migration finalization; removes an unused stopgap tsconfig and gitignores a generated artifact; no user-facing change. -->
