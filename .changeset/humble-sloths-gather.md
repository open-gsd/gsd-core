---
type: Fixed
pr: 5064
---
**Fixed the manager's ROADMAP checkbox projection mis-attributing phase checkboxes.** An unanchored regex let a checklist line's checkbox bind to the wrong phase whenever its own prose mentioned a later phase number, and a global last-match-wins scan let a later checklist line silently overwrite an earlier phase's correct checkbox state — both could report the wrong phase as next/complete. (#4982)
