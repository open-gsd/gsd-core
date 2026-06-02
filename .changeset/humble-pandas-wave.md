---
type: Fixed
pr: 510
---
**Removed stale `Source: sdk/src/...` generated-file banners from `get-shit-done/bin/lib/*.cjs`** — 13 hand-maintained CJS modules carried `GENERATED FILE — DO NOT EDIT` / `Source: sdk/src/...` / `Regenerate: cd sdk && npm run gen:...` headers pointing at a generation pipeline retired by ADR-0174 (no `sdk/` dir, no `gen:*` scripts, no `*.generated.cjs`). The banners misrepresented the files as machine-generated and pointed readers and automated reporters at deleted sources. Also deletes orphaned generator-era infra `scripts/generator-freshness-contract.cjs` + its test. No runtime behavior change. (#510)
