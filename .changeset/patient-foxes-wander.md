---
type: Fixed
pr: 5444
---
The end-of-phase TDD review now credits a RED-only probe plan with the GREEN commit of a plan that lists it in depends_on, so a gap closure split into a probe plan and a fix plan no longer blocks the phase permanently (#4867).
