---
id: 27a
title: Post-Execute Codebase Drift Detection
group: Brownfield Features
order: 27.2
---

**Introduced by:** #2003
**Trigger:** Runs automatically at the end of every `/gsd-execute-phase`
**Configuration:**
- `workflow.drift_threshold` (integer, default `3`) — minimum new
  structural elements before the gate acts.
- `workflow.drift_action` (`warn` | `auto-remap`, default `warn`) —
  warn-only or spawn `gsd-codebase-mapper` with `--paths` scoped to
  affected subtrees.

**What counts as drift:** additions are drift outside mapped territory;
modifications and deletions are drift inside it.
- New directory outside mapped paths (`new_dir`)
- New barrel export at `(packages|apps)/*/src/index.*` (`barrel`)
- New migration file (supabase/prisma/drizzle/src/migrations/…) (`migration`)
- New route module under `routes/` or `api/` (`route`)
- Modified file inside a mapped directory (`modified`; a typechange counts here)
- Deleted file inside a mapped directory (`deleted`; a rename's old path counts here, its new path as an addition)

**Why the rule is inverted.** A new directory is by definition outside what
the map describes, so an addition is drift where the map is silent. An edit or
deletion can only matter where the map does speak: a map that names a
directory describes its contents, and changing or removing them makes the
description stale. Counting modifications outside mapped territory would flag
every ordinary edit; counting only additions, as the gate did before #5134,
never flagged a map that went stale through edits or deletions.

**Mapped territory is the whole map.** The gate reads all seven
`.planning/codebase/*.md` documents, not only `STRUCTURE.md`. A directory is
mapped when its path appears, at a path-component boundary, in any of them.
`STRUCTURE.md` remains required. A document that is not a regular file or is
larger than 1 MiB is unreadable and is reported in `documents_unreadable`
(for `STRUCTURE.md`, the gate skips with `cannot-read-structure-md`).

**Unsafe paths are withheld, not printed.** `affected_paths`, the `--paths`
argument and the paths listed in the message pass only through the path
allowlist (ASCII letters, digits, `_ . -`, `/`-separated, no `..`, not
absolute). A path that fails is never interpolated into the message or the
mapper prompt; the message states how many were withheld and
`withheld_paths` / `withheld_count` carry them for inspection. A directory with
a non-ASCII or space-containing name is withheld and counted rather than
dropped silently. If no safe path remains, `auto-remap` does not spawn the
mapper. See [`verify codebase-drift`](../CLI-TOOLS.md#verify-codebase-drift-structural-drift-of-the-codebase-map-2003-5134).

**Non-blocking guarantee:** any internal failure (missing STRUCTURE.md,
git errors, mapper spawn failure) logs a single line and the phase
continues. Drift detection cannot fail verification.

**Requirements:**
- REQ-DRIFT-01: System MUST detect the six drift categories from `git diff
  --name-status last_mapped_commit..HEAD`
- REQ-DRIFT-02: Action fires only when element count ≥ `workflow.drift_threshold`
- REQ-DRIFT-03: `warn` action MUST NOT spawn any agent
- REQ-DRIFT-04: `auto-remap` action MUST pass sanitized `--paths` to the mapper
- REQ-DRIFT-05: Detection/remap failure MUST be non-blocking for `/gsd-execute-phase`
- REQ-DRIFT-06: `last_mapped_commit` round-trip through YAML frontmatter
  on each `.planning/codebase/*.md` file
