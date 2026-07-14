---
type: Fixed
pr: 2260
---
**Headless MemPalace capture no longer fails silently** — the headless invocation `mempalace mine <path> --wing <wing> --room <room>` used a `--room` flag that does not exist on the `mine` subcommand (only `search` accepts `--room`), causing every headless/no-MCP capture run to fail with `unrecognized arguments: --room` and silently skip (onError: skip). The fix replaces the flag with MemPalace's documented room-assignment mechanism: stage the artifact under a room-named subfolder with a `mempalace.yaml` taxonomy so `detect_room()` assigns it via folder-path match. (#2220)
