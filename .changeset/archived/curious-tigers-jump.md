---
type: Fixed
pr: 222
---
**`gsd-research-synthesizer` now hard-enforces Write-tool SUMMARY creation semantics** — Step 6 now declares SUMMARY.md-on-disk as canonical output and adds explicit hard rules against returning content in the response, permission-asking, and heredoc fallback. This closes the intermittent hallucinated write-restriction failure mode reported in #222. (#222)
