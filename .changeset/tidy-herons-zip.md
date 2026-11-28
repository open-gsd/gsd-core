---
type: Fixed
pr: 6824
---
**`/gsd-resume-work` claims a role handoff exclusively on Windows** — two sessions resuming the same role could both claim it, because two renames of one file can both succeed there, and one session then failed reading a file the other had moved; the claim now first creates an exclusive marker `.planning/.handoff-claim.<role_id>`, so exactly one session wins on every platform, and a marker left by a crash is swept after a day. (#6820)
