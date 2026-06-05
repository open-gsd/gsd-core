---
type: Fixed
pr: 3815
---
**`phase.insert` now handles checked-bullet ROADMAP format** — `gsd-sdk query phase.insert` (and `gsd-tools phase insert`) previously threw "Phase N not found" on ROADMAPs that use the `- [ ] **Phase N: name**` checklist format instead of `### Phase N: name` headings. The parser now detects purely bullet-style ROADMAPs and inserts the new decimal phase entry between the target bullet and the next phase bullet (preserving bold vs plain formatting). Hybrid ROADMAPs that mix heading-style phases with bullet summaries continue to produce the "missing a detail section" error from #3098, since a bullet-only entry in that context means the `### Phase N:` detail section is absent. (#3815)
