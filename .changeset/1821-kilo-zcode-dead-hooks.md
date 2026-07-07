---
type: Fixed
pr: 2057
---
**The installer no longer copies dead lifecycle hook scripts for Kilo and ZCode** — both declare `hooksSurface: 'none'` and have no plugin surface, so the staged `hooks/*.js`, `hooks/*.sh`, `hooks/lib/` and the CommonJS `package.json` marker were dead weight in `~/.kilo/` and `~/.zcode/`. The two hook-copy guards in `install.js` now exclude Kilo and ZCode alongside the other no-hook runtimes. OpenCode, which also declares `hooksSurface: 'none'`, is deliberately kept: its native plugin adapter (#1914) spawns those staged hooks via OpenCode's event bus and needs both them and the marker.
