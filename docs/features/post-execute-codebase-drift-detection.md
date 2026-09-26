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
  affected subtrees. Affected paths are filtered first (REQ-DRIFT-04), and
  any prefix withheld is named in the message and in `dropped_paths`.
  `auto-remap` degrades to `warn` when any prefix is withheld or none
  survives: the gate reports the drift and spawns nothing, rather than
  remapping the whole tree or stamping a partial remap as complete.

**What counts as drift:**
- New directory outside mapped paths
- New barrel export at `(packages|apps)/*/src/index.*`
- New migration file (supabase/prisma/drizzle/src/migrations/…)
- New route module under `routes/` or `api/`
- Modified file inside a directory `STRUCTURE.md` already describes (#4886)
- Deleted file inside a directory `STRUCTURE.md` already describes (#4886)

The two rules are mirror images: an ordinary *added* file is drift when the map
does **not** know its directory (a barrel, migration or route addition counts
wherever it lands); a *modified* or *deleted* file is drift when the map
**does**, because what the map describes has changed. A change in territory
the map never described is not divergence from the map and is not counted.

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
