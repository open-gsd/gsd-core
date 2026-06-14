---
type: Fixed
pr: 1249
---
**`phase add` no longer reuses an existing phase number when that phase exists only as a roadmap bullet** — the next-number scan now counts phases listed only as `- [ ] **Phase N: ...**` bullets (all checkbox variants, with or without a title), in addition to `### Phase N:` section headers and on-disk phase directories, so a bullet-only phase is no longer shadowed and `phase add` appends after the highest used number.
