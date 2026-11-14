---
type: Fixed
pr: 5620
---
**`/gsd-phase --insert` now documents and forwards `--sibling`, and accepts a decimal after-phase** — inserting after a decimal phase nests by default (`15.2` -> `15.2.1`); `--insert 15.2 --sibling "x"` creates the peer `15.3`. Bracket phase ids refuse a nested insert after a decimal phase; use `--sibling`. The insert workflow previously rejected a decimal `<after>` and had no slot to pass the flag. A `--ws <name>` typed with `--insert`, quoted or not, now reaches the insert and both STATE.md updates, so they no longer run in the active workstream. (#5583)
