---
type: Fixed
pr: 5442
---
**PR templates no longer link to 404 pages** — the default, feature and enhancement templates use absolute URLs, because a relative href resolves against `/pull/N` in a PR body. The Documentation Updates anchor now has its two hyphens. A new test fails when a template holds a relative link other than `?template=`. (#5427)
