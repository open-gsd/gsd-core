---
type: Added
pr: 6819
---
**The statusline and `/gsd-next` follow per-session pause** — the statusline shows `paused` when your own session holds a handoff and `⏸N` for handoffs other sessions hold, and `/gsd-next` routes to resume only for a handoff your session owns, so one paused session no longer marks every other session on the same `.planning/` as paused. The context monitor's exhaustion breadcrumb is attributed to the session that ran out of context. (#6797)
