---
type: Fixed
pr: 2253
---
**`phase remove` no longer destroys the Progress table when removing the last phase** — deleting a phase used a whole-document regex whose scan, on the final phase, ran past the section and swept away the `## Progress` heading and its entire tracking table; the deletion is now structurally bounded to the phase’s own section. (#2253)
