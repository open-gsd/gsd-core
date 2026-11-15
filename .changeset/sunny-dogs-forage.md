---
type: Fixed
pr: 5442
---
**PR templates no longer link to 404 pages** — the default, feature, enhancement and registry-entry templates use absolute URLs (relative hrefs resolve against `/pull/N` in a PR body), and the Documentation Updates anchor now has its two hyphens. Two behaviour changes come with the fix. A PR template, `CONTRIBUTING.md` or `docs/registries/README.md` edit now runs the `test-inert` lane (`isLightweight`, scripts/ci-test-scope.cjs:41) instead of skipping CI. The ADR link gate (`extractLinks`, scripts/gen-adr-index.cjs:594) stops reading some forms as links. These forms are `[a](x y)`, `[a]()`, a destination with an ASCII control character, an escaped bracket and an escaped parenthesis. Also `[a](<x<y>)`, `[a](<x)`, `[a](<x>y)` and a parenthesis inside a title or an angle destination. A title that is doubled, unterminated or followed by other text ends the link too. (#5427)
