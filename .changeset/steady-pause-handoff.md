---
type: Fixed
pr: 0
---
**`/gsd-next` and `/gsd-progress --next` route to `/gsd-resume-work` after a pause** — `/gsd-pause-work` writes `.planning/HANDOFF.json` but never `paused_at`, so the smart-entry "paused" situation and the next workflow's Route 8 could not fire after a pause, and `--next` hard-stopped only for a root-level `.continue-here.md`, not the phase-scoped one pause-work usually writes; the handoff file now classifies as paused (and `/gsd-resume-work` deleting it routes forward again), and a new Gate 0 in the next workflow routes a recorded pause to resume before any other gate. (#6431)
