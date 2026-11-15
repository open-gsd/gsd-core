---
type: Fixed
pr: 5442
---
**PR templates no longer link to 404 pages** — the default, feature, enhancement and registry-entry templates use absolute URLs (relative hrefs resolve against `/pull/N` in a PR body), and the Documentation Updates anchor now has its two hyphens. Two behaviour changes come with the fix: a PR template, `CONTRIBUTING.md` or `docs/registries/README.md` edit now runs the `test-inert` lane (`isLightweight`, scripts/ci-test-scope.cjs:41) instead of skipping CI, and the ADR link gate (`extractLinks`, scripts/gen-adr-index.cjs:569) no longer reads `[a](x y)`, `[a]()`, an escaped bracket or an escaped parenthesis as a link. (#5427)
