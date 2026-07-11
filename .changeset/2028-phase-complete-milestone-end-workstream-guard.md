---
type: Fixed
pr: 2066
---
**`phase complete` no longer marks a milestone done out of order, nor silently writes root state in workstream mode.** Completing the numerically-highest phase while an earlier phase was still outstanding wrongly flipped STATE.md to `Status: Milestone complete` (the milestone-end check only looked for higher-numbered phases, so an out-of-order completion — e.g. Phase 10 before Phase 9 — read as the end). It now reports milestone-end only when every lower-numbered phase in the milestone is checked complete. Separately, in workstream mode with no active workstream, `phase complete` previously fell back to root `.planning` and wrote STATE.md/ROADMAP.md (and the mislabel) into the shared root other workstreams read; it now fails safe — asking for `--ws <name>` or an active workstream — mirroring the existing `init progress` guard. (#2066)
