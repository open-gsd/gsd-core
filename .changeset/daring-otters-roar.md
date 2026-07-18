---
type: Fixed
pr: 2404
---
**A phase with a deliberately-unexecuted (superseded) plan no longer stays stuck below 100%** — a plan reassigned or dropped mid-phase can never gain a matching SUMMARY, yet plan-scan counted it forever, so the phase read In Progress and the milestone sat below 100% permanently — the plan-level analogue of the retired-phase bug (#1514). Mark such a plan `status: superseded` in its PLAN.md frontmatter and it is now excluded from both the plan and summary counts, so the phase completes honestly (a 13-plan phase with 2 superseded reads 11/11). Plans without the marker are unchanged. (#2349)
