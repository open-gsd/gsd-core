---
type: Changed
pr: 2010
---
**MemPalace `memory_mode` `kg_backend` and `replace` are now functional** — selecting either mode now routes recall through the palace instead of silently behaving like `augment`: `kg_backend` treats the palace temporal KG as the primary knowledge-graph source (native `.planning/graphs/` as fallback), and `replace` resolves recall through the palace as the source of truth. Every mode stays default-resilient — an unreachable palace falls back to native memory and no memory is lost. (#2010)
