---
type: Changed
pr: 0
---
**INVENTORY.md no longer carries `(N shipped)` count scalars** — the hand-maintained absolute counts collided silently on merge (two branches each bumping the same integer to N+1 while the merged tree held N+2), red-flagging CI on the merge commit across all platforms. The manifest's name-set is now the sole registry, anchors are count-free and stable, and a guard test blocks re-adding a count. (#1170)
