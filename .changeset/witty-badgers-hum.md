---
type: Fixed
pr: 0
---
**Dependency tree no longer carries a known body-parser advisory** — GHSA-v422-hmwv-36x6 (low-severity DoS via invalid `limit` value, published 2026-07-20) in `body-parser@2.2.2` was pulled transitively via `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk` → `express` and surfaced by `npm audit --omit=dev`. Re-resolved `body-parser` to 2.3.0 in `package-lock.json` within `express`'s already-declared `^2.2.1` range; no `overrides` block needed, `package.json` is unchanged.
