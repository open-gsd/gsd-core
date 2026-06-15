---
type: Fixed
pr: 1199
---

**Wire the discuss loop step for capability hooks** — capabilities can now register `discuss:pre`/`discuss:post` hooks (e.g. discuss-time context recall and CONTEXT capture); previously `discuss` was contract-declared but structurally unwireable. Also collapses the host-loop file set to a single source of truth and adds an authoring-time guard rejecting hooks at unwired extension points. (#1199)
