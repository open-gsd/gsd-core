---
type: Added
pr: 5378
---
**`/gsd-pause-work` / `/gsd-resume-work` are per session** — handoffs are keyed by role (`HANDOFF.latest.<role_id>.json`) and claimed on resume; shipped workflows no longer set the project-wide `paused_at`; new `state session-resume` / `state sessions` verbs and `.planning/sessions/<sid>.json` records; the statusline shows `paused` only for its own session and `⏸N` for others.
