---
type: Fixed
pr: 376
---
Claude installs now rewrite `/gsd:<cmd>` → `/gsd-<cmd>` in installed hook `.js`/`.cjs` files (matching the existing rewriter behavior for other hyphen-namespace runtimes) — statusline / update-banner / workflow-guard / context-monitor messages no longer leak the colon namespace.
