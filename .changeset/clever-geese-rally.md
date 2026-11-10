---
type: Fixed
pr: 6026
---
**execute-phase no longer marks a finished phase as executing** — a resume that dispatched no plan (the verify-only resume, a filter that selects nothing, or a phase stuck on blocked or not-ready plans) still rewrote STATE.md's Current Position, Status and Last activity to "Executing, Plan 1 of N"; the phase start is now recorded only once a plan is about to run (#5843).
