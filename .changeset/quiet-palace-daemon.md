---
type: Fixed
pr: 6470
---
**Headless MemPalace capture no longer starts a daemon that blocks the MCP write tools** — the capture ran `mempalace mine --daemon --background` unconditionally, and on MemPalace 3.12 `--daemon` auto-starts a daemon that holds the palace writer lock until someone runs `mempalace daemon stop`, so every MCP write tool was refused after the first headless capture; the daemon route is now used only when `mempalace daemon status` reports a running daemon, otherwise a plain `mine` is retried with bounded backoff and a final failure prints `MemPalace capture skipped — palace locked`. (#6266)
