---
type: Fixed
pr: 5442
---
**PR templates no longer link to 404 pages** — the default, feature, enhancement and registry-entry templates use absolute URLs (relative hrefs resolve against `/pull/N` in a PR body), and the Documentation Updates anchor now has its two hyphens. Two behaviour changes come with the fix. A PR template, `CONTRIBUTING.md` or `docs/registries/README.md` edit now runs the `test-inert` lane (`isLightweight`, scripts/ci-test-scope.cjs:41) instead of skipping CI. The ADR link gate (`extractLinks`, scripts/gen-adr-index.cjs:572) no longer reads these as links: `[a](x y)`, `[a]()`, an escaped bracket, an escaped parenthesis, a parenthesis inside a title or an angle destination, a `<` inside an angle destination, an unclosed `<`, text after an angle destination, and a title that is doubled, unterminated or followed by other text. (#5427)
