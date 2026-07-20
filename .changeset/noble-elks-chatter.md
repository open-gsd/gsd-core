---
type: Fixed
pr: 0
---
**`check.decision-coverage-plan` no longer false-blocks on decisions cited in `<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>`** — the gate scanned only `<objective>`/`<tasks>`/`<task>`/`<action>` tag bodies while its remediation message claimed "(or body)". A decision faithfully cited in any of the five other planner-canonical tags (the natural place for "read this CONTEXT decision before editing" pointers, verification steps, acceptance criteria, etc.) was reported as uncovered with a misleading fix-hint that sent the fixer to "the body" — where a re-citation still failed. The scan now covers all nine planner-canonical tag bodies AND the message names the surfaces it actually scans, so message and behavior cannot drift apart again. (#2372)
