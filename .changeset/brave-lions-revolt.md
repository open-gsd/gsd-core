---
type: Fixed
pr: 1193
---
**`query user-story.validate` now works** — `mvp-phase` and `verify-work` workflows both invoked this command to validate "As a / I want to / so that" user stories, but no CJS handler existed; every call errored with "Unknown command: user-story". (#1193)
