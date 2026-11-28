# Why the codebase drift gate is built the way it is

> Explanation. What the gate counts, its configuration and its requirements are in the
> [Post-Execute Codebase Drift Detection feature entry](../FEATURES.md); the verb is in
> [`verify codebase-drift`](../CLI-TOOLS.md#verify-codebase-drift-structural-drift-of-the-codebase-map-2003-5134).
> Where the gate sits in the pipeline is in [Architecture](../ARCHITECTURE.md#post-execute-codebase-drift-gate-2003).

## Why the rule is inverted

A new directory is by definition outside what the map describes, so an addition is drift
where the map is silent. An edit or deletion can only matter where the map does speak: a map
that names a directory describes its contents, and changing or removing them makes the
description stale. Counting modifications outside mapped territory would flag every ordinary
edit; counting only additions, as the gate did before #5134, never flagged a map that went
stale through edits or deletions.

## Why the baseline stamp is written by a shell step, not the mapper agent

The baseline is written by `gsd-tools stamp-codebase-map`, a shell step in the map-codebase
workflow, not by the mapper agent. The mapper's own freshness markers (`**Analysis Date:**`,
`<!-- refreshed: ... -->`) are restamped unconditionally on an Update run, so an agent that
rewrites only the dates still looks current to a reader; the machine-readable stamp is the one
marker that cannot be satisfied by a date-only rewrite, which is exactly why it is not the
agent's to write. `--files a.md,b.md` narrows the stamp to the documents a caller actually
refreshed, as the auto-remap path does.

## Why an absent baseline is skipped, not drift

An absent or unresolvable baseline is reported as `skipped` with reason `no-mapped-commit` or
`unresolvable-mapped-commit`, never as drift. Diffing HEAD against the empty tree would report
every tracked file as newly added, which makes a stale map indistinguishable from a fresh one.
Files under `.planning/` are excluded from the diff: the map's own commit is a planning
artifact, not codebase structure.
