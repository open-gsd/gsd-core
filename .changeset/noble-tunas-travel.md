---
type: Fixed
pr: 5345
---
**OpenCode: hook advisories now reach the model, and the session-start scripts run on 2.x** — read-before-write, injection findings and phase-boundary reminders were logged where no model reads them, on both OpenCode generations; they are now appended to the tool result, so OpenCode 1.x users start seeing advisories that were always meant to be shown. A 2.x run emits no session-created event, so the canonical-path and update-check scripts never ran there; they do now.
