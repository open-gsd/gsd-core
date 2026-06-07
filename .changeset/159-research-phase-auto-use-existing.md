---
type: Changed
pr: 718
---
`/gsd:plan-phase --research-phase <N>` now auto-uses an existing `RESEARCH.md` instead of prompting update/view/skip. When research already exists and neither `--research` nor `--view` is passed, it emits a one-line notice and exits cleanly, matching the promptless behavior of standard `/gsd:plan-phase <N>`. Pass `--research` to force-refresh or `--view` to print the existing research. (#159)
