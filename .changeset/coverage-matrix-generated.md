---
type: Added
pr: 6792
---
**A generated documentation coverage matrix now lists every command, `gsd-tools` verb, config key, agent, hook, template and installer flag with where it is documented and which options are not** — `docs/reference/coverage-matrix.md` is produced by `scripts/gen-coverage-matrix.cjs` from each surface's own source, and `npm run lint:generated-sync` fails when the committed page is stale. (#6771)
