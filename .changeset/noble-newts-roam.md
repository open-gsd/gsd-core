---
type: Fixed
pr: 0
---
**`/gsd` now registers on pi** — installing GSD for pi wrote its extension as `gsd.cjs`, a suffix pi's extension auto-discovery skips silently, so `/gsd` never appeared and nothing reported an error. The extension now installs as `gsd.js`, and upgrading removes the stale `gsd.cjs`. (#2470)
