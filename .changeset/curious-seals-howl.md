---
type: Fixed
pr: 845
---
**Release version bumps now keep runtime manifest versions in sync** — `.claude-plugin/plugin.json` and `gemini-extension.json` are stamped to match `package.json` on every `npm version`, unblocking RC/finalize releases. New version-bearing manifests must be registered in `scripts/sync-manifest-versions.cjs` (enforced by a regression test).
