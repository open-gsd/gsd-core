---
type: Changed
pr: 541
---
Runtime `bin/lib` modules can now be authored as TypeScript and compiled to CommonJS via `tsc` (ADR-457 build-at-publish pilot). The first module, `semver-compare`, moves to `src/semver-compare.cts`; its `.cjs` is now a generated, gitignored build artifact emitted by `npm run build:lib` (wired into build, pretest, prepare, and prepublishOnly). Behavior is unchanged and the package still ships CommonJS.
