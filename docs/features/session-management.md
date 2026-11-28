---
id: 23
title: Session Management
group: Context Engineering Features
---

**Commands:** `/gsd-pause-work`, `/gsd-resume-work`, `/gsd-progress`

**Purpose:** Maintain project continuity across context resets and sessions.

**Requirements:**
- REQ-SESSION-01: Pause MUST save current position and next steps to a `.continue-here` file and a structured handoff that belongs to the pausing session: `HANDOFF.latest.<role_id>.json` with a role, `HANDOFF.<session_id>.json` without one, legacy `HANDOFF.json` when the session has no id. Pause MUST NOT write `paused_at` or `status: paused` to STATE.md
- REQ-SESSION-02: Resume MUST claim a role handoff by an exclusive claim marker (`.handoff-claim.<role_id>`) and then a rename to `HANDOFF.claimed.<role_id>.<session_id>.json`, before reading it, restore the role, and remove the consumed files; a second session resuming the same role MUST find no unclaimed handoff and be told so. Resume MUST restore full project context from the handoff (preferred) or state files (fallback); a legacy `HANDOFF.json` remains readable
- REQ-SESSION-03: Progress MUST show current position, next action, and overall completion
- REQ-SESSION-04: Progress MUST read all state files (STATE.md, ROADMAP.md, phase directories)
- REQ-SESSION-05: All session operations MUST work after `/clear` (context reset)
- REQ-SESSION-06: The handoff MUST include blockers, human actions pending, and in-progress task state, plus the `session_id`, `role` and `role_id` it was written under
- REQ-SESSION-07: Resume MUST surface human actions and blockers immediately on session start
