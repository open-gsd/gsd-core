---
type: Fixed
pr: 5358
---
`phase complete` no longer writes `Ready to plan` / `Current Plan: Not started` for a next phase that is already planned or executed; Status, Current Plan and Stopped at now route to execution or verification from the phase's disk state (#4824)
