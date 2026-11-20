---
type: Fixed
pr: 6447
---
**The model-profiles advisor section matches its upstream sources and states the caveats** — it no longer points at the closed-as-not-planned per-subagent advisor tracker as pending, gives the first release that mentions the advisor (v2.1.117) instead of a version no changelog entry supports, and now says every advisor call sends the calling agent's full transcript, that the advisor's own read is uncached by default, that advisor tokens are billed separately in `usage.iterations[]`, how to turn the advisor off, and that a subagent inherits the advisor only if it passes the same pairing check. (#6205)
