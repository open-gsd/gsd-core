---
type: Changed
pr: 5620
---
**`/gsd-phase --insert` now documents and forwards `--sibling`, and accepts a decimal after-phase** — inserting after a decimal phase nests by default (`15.2` -> `15.2.1`); `--insert 15.2 --sibling "x"` creates the peer `15.3`. The insert workflow previously rejected a decimal `<after>` and had no slot to pass the flag. (#5583)
