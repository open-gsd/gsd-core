---
type: Fixed
pr: 1350
---

**UAT resume now accepts paused checkpoints** — `uat render-checkpoint` treats a non-structured paused `Current Test` placeholder as a resume signal and derives the checkpoint from the first pending UAT test instead of failing as malformed. (#1300)
