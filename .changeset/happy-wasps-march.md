---
type: Fixed
pr: 5577
---
**`roadmap update-plan-progress` ticks only the completing phase's own checklist bullet** — a bullet that merely mentioned "Phase N" (for example `v1.0 - Phase 1 through Phase 2`) was ticked instead, and the `(completed …)` annotation could land on the following line. The writer and its gate now share one line-anchored bullet grammar, so a decorated bullet (emoji prefix, blockquote, leading text) is no longer treated as the phase's own bullet, matching `roadmap analyze`. (#5545)
