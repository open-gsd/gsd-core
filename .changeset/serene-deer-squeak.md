---
type: Fixed
pr: 0
---
**mempalace capture queues instead of dropping writes** — the headless `mempalace mine` ran in the foreground, so a concurrent writer holding the palace lock made it exit 1 and the onError: skip step silently dropped the capture. The mine now queues via `--daemon --background` (MemPalace runs it when the lock frees), and the capture report surfaces the queued or skipped outcome instead of staying silent. (#4700)
