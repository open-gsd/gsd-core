---
type: Fixed
pr: 2497
---
**Production dependency tree carries no known advisories** — five advisories disclosed against the transitive tree under `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk` were cleared: `fast-uri` (GHSA-4c8g-83qw-93j6, high) and `hono` (GHSA-xgm2-5f3f-mvvc, GHSA-hvrm-45r6-mjfj, GHSA-w62v-xxxg-mg59) re-resolved to patched releases inside their already-declared ranges with no `package.json` change, and `@hono/node-server` (GHSA-frvp-7c67-39w9) pinned to `>=2.0.5` via `overrides` because `@modelcontextprotocol/sdk@1.29.0` — already the latest published version — still declares the vulnerable `^1.19.9` range. `npm audit --omit=dev` reports zero advisories. (#2496)
