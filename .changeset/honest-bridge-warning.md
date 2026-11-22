---
type: Fixed
pr: 6476
---
**`/gsd-health` reports W032 when the gsd-core Claude Code plugin is enabled but no statusline feeds the context monitor** — the plugin registers `gsd-context-monitor.js` but not `gsd-statusline.js`, the only writer of the bridge file the monitor reads, so a plugin-only install silently never shows the 35% and 25% remaining context warnings (and the opt-in hooks the npm installer registers are inactive too); the new advisory W032 names the cause and the fix (the npm installer), and an npm install, a disabled plugin or another runtime reports nothing. (#6430)
