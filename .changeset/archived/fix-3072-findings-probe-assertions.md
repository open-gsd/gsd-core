---
type: Fixed
pr: 3119
---
**Optional findings probe guard checks now use structured parsing** — regression tests now parse fenced bash blocks and validate sketch/spike findings probes as structured command records, ensuring non-fatal `|| true` guards are enforced without raw source grep assertions.