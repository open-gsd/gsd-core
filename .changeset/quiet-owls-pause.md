---
type: Added
pr: 6823
---
**`/gsd-pause-work` and `/gsd-resume-work` now pause and resume per session** — pausing with `--role <text>` writes `HANDOFF.latest.<role_id>.json` and `.continue-here.latest.<role_id>.md`, and a session without a role writes its own `HANDOFF.<session_id>.json`; nothing is written to `paused_at` or `status: paused`. Resuming claims a role handoff by atomic rename before reading it, restores the role and removes the consumed files, so a second session resuming the same role finds no handoff instead of taking the first session's. `/gsd-next` routes to resume only for the session's own handoff, and a legacy `HANDOFF.json` stays readable. (#6798)
