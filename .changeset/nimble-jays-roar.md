---
type: Added
pr: 1861
---
GSD Core ships a `.claude-plugin/marketplace.json` marketplace manifest so Claude-plugin-compatible runtimes (ZCODE et al.) can discover and install gsd-core from a custom marketplace source. Additive — the existing `.claude-plugin/plugin.json` and the Claude Code install path are unchanged. The catalog version (`plugins[0].version`) tracks `package.json` via the release version-sync.
