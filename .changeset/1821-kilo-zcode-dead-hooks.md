---
type: Fixed
pr: 2057
---
**The installer no longer copies dead lifecycle hook scripts for ZCode** — it declares `hooksSurface: 'none'` and has no plugin surface, so the staged `hooks/*.js`, `hooks/*.sh`, `hooks/lib/` and the CommonJS `package.json` marker were dead weight in `~/.zcode/`. The hook-copy guards in `install.js` now exclude ZCode alongside the other no-hook runtimes. OpenCode, which also declares `hooksSurface: 'none'`, is deliberately kept: its native plugin adapter (#1914) spawns those staged hooks via OpenCode's event bus and needs both them and the marker. (This fix originally excluded Kilo too, on the premise that it had no plugin surface; that premise was wrong — Kilo's native plugin spawns the staged guard hooks, exactly like OpenCode's — and #2327 reverses the Kilo half.)
