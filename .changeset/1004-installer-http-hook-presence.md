---
type: Fixed
pr: 1032
---
**Installer no longer appends a duplicate managed hook when it is registered via an HTTP route** — a hook re-registered as a `type:"http"` entry (local hook-server routing) carries its identity only in `url`, which the installer's presence check ignored, so a stock command duplicate was appended on every install/update and the hook ran twice per event. The presence check now also inspects `h.url`. (#1004)
