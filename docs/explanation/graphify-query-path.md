# Why planners and researchers query graphify first

> Explanation. What changed, the fallback rule and the known limits are in the
> [Graphify CLI Preferred feature entry](../FEATURES.md).

## Why the single query matters

`gsd-planner` gets **one** knowledge-graph query per phase and `gsd-phase-researcher` gets two
or three. That single shot decides which modules the plan treats as related, and therefore how
tasks are ordered into waves. It was spent on the built-in reader, which seeds by
case-insensitive **substring** match over a node's label and description and then expands a
hardcoded two hops — so the phase "User Authentication" seeds on `author`, `authoring`, and
`unauthorized` with exactly the same weight as `authenticate`, and when the inflated result
exceeds `--budget` the trimmer drops edges by confidence tier. The `graphify` CLI, already a
hard dependency of `/gsd-graphify build`, ranks seeds (IDF weighting, trigram fuzzy matching)
and applies context filters before traversal.

## Why the planner also runs `graphify affected`

The reference states its own goal as "which subsystems may be affected by changes in this
phase", which is literally reverse traversal by relation. The built-in reader only
approximates it with undirected two-hop expansion, and has no equivalent verb, so `affected`
is skipped on the fallback path.
