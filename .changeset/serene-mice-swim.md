---
type: Changed
pr: 1117
---
Edge-probe now surfaces a zero-classification requirement (non-empty prose, no shape cue matched, no `shapes` override) as a single soft `unclassified — review manually` candidate instead of silently dropping it. Dismissible like any edge; `shapes: []` opt-out stays silent; TAXONOMY unchanged.
