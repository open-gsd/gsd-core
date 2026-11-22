---
type: Fixed
pr: 6472
---
**`state update-progress` and `state sync` name the cause and the fix when they decline as unscoped** — a project whose STATE.md `milestone:` names a version with no matching ROADMAP.md heading (for example a flat ROADMAP with no milestone headings) declined on every call with only `phase scope is unscoped, not complete`, so its counters drifted unnoticed; the warning and a new `hint` field (non-raw output) now name the milestone and the fix for the actual cause (set `milestone: null`, add the heading above its phases, name a milestone in STATE.md, or reword a Phase title that reads as a milestone heading). The scope classification is unchanged. (#6271)
