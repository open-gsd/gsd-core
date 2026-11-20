---
type: Fixed
pr: 0
---
**Plan-review convergence records the live plan count in STATE.md** — the converged step passed the physical count taken before the loop, which counted superseded plans and missed plans added or removed during convergence. It now re-reads the live (non-superseded) count right before `state planned-phase`; the initial planning check keeps the physical count. (#6122)
