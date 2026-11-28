---
type: Fixed
pr: 6876
---
**The regression gate now excludes exactly the current phase's directory** — it used to drop every phase whose directory contained the phase number (phase 3 also dropped `13-x`), and the fence never set the phase number, so it could keep nothing. The fence now resolves the current phase's directory and skips only that one. Decimal phases are phases of their own and stay in the regression set (`03.1` and `03.10` under current `03`; `03` and `03.10` under current `03.1`). With `--ws`, the workstream's phases are searched. If the phase does not resolve to exactly one directory, the gate stops with an error instead of running against the wrong set. (#6813)
