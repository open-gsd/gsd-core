---
type: Fixed
pr: 0
---
**`state update-progress` names the cause and the fix when it declines as unscoped** — a project whose STATE.md `milestone:` names a version with no matching ROADMAP.md heading (for example a flat ROADMAP with no milestone headings) declined on every call with only `phase scope is unscoped, not complete`, so its counters drifted unnoticed; the warning and a new `hint` field now say the cause and the fix (add the heading, correct STATE.md's milestone, or set `milestone: null`). The scope classification is unchanged. (#6271)
