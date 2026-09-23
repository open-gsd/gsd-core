---
id: 4836
title: Graphify CLI Preferred for Planner and Researcher Graph Queries
group: v1.7.0 Features
---

**Purpose:** `gsd-planner` gets **one** knowledge-graph query per phase and
`gsd-phase-researcher` gets two or three. That single shot decides which modules
the plan treats as related, and therefore how tasks are ordered into waves. It
was spent on the built-in reader, which seeds by case-insensitive **substring**
match over a node's label and description and then expands a hardcoded two hops
— so the phase "User Authentication" seeds on `author`, `authoring`, and
`unauthorized` with exactly the same weight as `authenticate`, and when the
inflated result exceeds `--budget` the trimmer drops edges by confidence tier.
The `graphify` CLI, already a hard dependency of `/gsd-graphify build`, ranks
seeds (IDF weighting, trigram fuzzy matching) and applies context filters before
traversal.

**Both prompts now prefer the CLI and fall back to the built-in reader.** The
branch is `command -v graphify`, the same degradation shape the repo already
uses for Context7 → `ctx7` in `references/research-documentation-lookup.md`. No
new config key: a `graph.json` can only exist if `graphify update .` ran, which
requires the binary, so binary presence is a self-satisfying gate. The fallback
covers edge cases — a CI checkout with a committed graph, a binary since removed
— not the common path. No new tool grant either: both agents already have
`Bash`.

**The planner additionally runs `graphify affected`.** The reference states its
own goal as "which subsystems may be affected by changes in this phase", which is
literally reverse traversal by relation. The built-in reader only approximates it
with undirected two-hop expansion, and has no equivalent verb, so `affected` is
skipped on the fallback path.

**`gsd-tools graphify status` now returns `graph_path`.** The CLI takes the graph
location as `--graph`, and the prompts must not re-derive
`.planning/graphs/graph.json` for it — that would point the CLI at a
non-existent local mirror in exactly the umbrella multi-repo setup
`graphify.graph_path` (#1825) exists to serve. `status` already resolves the
override, so it now reports the absolute path it resolved, on both the
graph-present and the graph-missing branch. For the same reason the presence gate
in both prompts is now the `status` call itself rather than a bare `ls` of the
default location.

**Known limits:**
- **The two paths return different shapes.** `graphify query` emits prose and has
  no `--json` flag; `gsd-tools graphify query` emits JSON with per-edge
  confidence tiers and `budget_met`/`budget_estimate`. Both are consumed by a
  model, and nothing machine-parses this block, but the prompts now say so
  explicitly instead of implying a stable shape.
- **`--budget` means different things on the two paths** — rendered output on the
  CLI, estimated payload bytes in the built-in reader (#2738). Same flag name,
  different unit.
- With `graphify` absent from `PATH` the fallback runs and the injected graph
  context is byte-identical to before.
