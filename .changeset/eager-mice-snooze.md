---
type: Fixed
pr: 5391
---
**`/gsd-ship` now dispatches `ship:pre` step hooks** — the preflight capability arm consumed only `kind == "gate"` entries, so a capability step registered at `ship:pre` (for example one recording a ship-override audit) was resolved by `render-hooks` and never ran. Steps now dispatch per the generic loop-hook contract after the gate loop; they honor `onError` and never block ship on their own. Gate evaluation is unchanged.
