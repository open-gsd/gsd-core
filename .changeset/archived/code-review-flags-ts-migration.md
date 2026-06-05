---
type: Changed
pr: 537
---
Migrate code-review-flags to a TypeScript source of truth (`src/code-review-flags.cts`), compiled to a gitignored `.cjs` build artifact per ADR-457 (#537). Behaviour is preserved byte-for-behaviour from the prior hand-written `.cjs`; adds compile-time type checking via strict TypeScript with `CodeReviewFlags` interface and `CodeReviewWorkflow` union type.

<!-- docs-exempt: Internal build-at-publish source migration (ADR-457). The hand-written .cjs is collapsed to a TS source compiled to a behaviourally-identical gitignored artifact at the same require() path. No user-facing command, output, behaviour, or configuration change. -->
