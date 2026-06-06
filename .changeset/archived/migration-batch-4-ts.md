---
type: Changed
pr: 537
---
Migrate 5 modules from hand-written CommonJS to TypeScript source of truth per ADR-457 (#537). Modules migrated: `configuration`, `state-document`, `shell-command-projection`, `security`, and `command-aliases`. Each `src/<m>.cts` compiles to a gitignored `get-shit-done/bin/lib/<m>.cjs` with behaviour preserved byte-for-behaviour; only strict types are added. The three modules previously in `tsconfig.lint.json` excludes (`configuration`, `state-document`, `command-aliases`) are now removed from that list.

<!-- docs-exempt: Internal ADR-457 build-at-publish source migration; behaviourally-identical gitignored artifacts at same require() paths; no user-facing change. -->
