# Unified `.gsd/` root with platform sub-namespaces for cross-platform compatibility

- **Status:** Proposed
- **Date:** 2026-06-02
- **Issue:** open-gsd/gsd-core#627
- **Related:** ADR-0006 (planning-path-projection-module), ADR-0008 (installer-migration-module), ADR-3660 (runtime-artifact-layout-module), #260 (worktree absolute-path guard)
- **Sibling decision:** open-gsd/gsd-pi#430 (mirrored enhancement)

## Context

gsd-core and gsd-pi are sibling platforms in the GSD family. Each persists its runtime state in a different top-level directory at the repo root:

- gsd-core → `.planning/` — **gitignored, local-only** (`.gitignore:33`; `git ls-files .planning` returns 0 tracked files), resolved through a single projection seam (`planningDir`/`planningRoot` in `get-shit-done/bin/lib/planning-workspace.cjs`, established by ADR-0006).
- gsd-pi → `.gsd/`.

These roots are conceptually parallel — both hold "the agent's long-horizon working memory" — but they share no convention. A repository cannot cleanly host both, and a user who wants to migrate from one platform to the other has no defined path. Both platforms market autonomous, long-running operation, which makes a durable, predictable on-disk home for state (and for the worktrees agents run in) a shared concern rather than an incidental one.

Separately, agent worktree storage is inconsistent within gsd-core: parallel executors use `.claude/worktrees/agent-<id>`, while `gsd-code-fixer` uses `mktemp -d /tmp/sv-...`. The `/tmp` location is not reboot-durable and may sit on a different filesystem than the repo.

## Decision

Adopt a **single `.gsd/` root at the repo root, partitioned by platform**:

```
.gsd/
├── gsd-core/                 # gsd-core runtime state (formerly .planning/)
├── gsd-pi/                   # gsd-pi runtime state
└── gsd-worktree/             # shared, gitignored, ephemeral agent worktrees
    ├── gsd-core/agent-<id>/  # per-platform leaf
    └── gsd-pi/agent-<id>/
```

1. **gsd-core relocates its projection root** from `.planning/` to `.gsd/gsd-core/`, behind the existing ADR-0006 projection seam. The `GSD_PROJECT`/`GSD_WORKSTREAM` segments continue to nest below the platform namespace. The duplicated literals in `observability/logger.cjs` (`PLANNING_DIR`) and `intel.cjs` (`INTEL_DIR`) are refactored to read from the seam rather than re-deriving the string.
2. **gsd-pi mirrors the convention**, keeping its state under `.gsd/gsd-pi/` (filed as a sibling enhancement, open-gsd/gsd-pi#430).
3. **Agent worktrees move to a per-platform leaf `.gsd/gsd-worktree/<platform>/`** — gitignored, co-located on the repo filesystem, platform-neutral — replacing `/tmp` and, over time, `.claude/worktrees/`. The #260 absolute-path guard extends to this location.
4. **Migration** (ADR-0008 precedent): since `.planning/` is gitignored/local-only, migration is a local `fs.rename('.planning' → '.gsd/gsd-core')` on first run — atomic on a single filesystem, idempotent, once per working copy, with a one-time notice. If `.gsd/gsd-core/` already exists it is canonical: warn and leave any stray `.planning/`, never silently merge. The `/gsd-pr-branch` command's `.planning/`-commit filter moves to `.gsd/gsd-core/` (or `.gsd/`) in lockstep.

### Worktree location — options evaluated

| Option | Pros | Cons |
|---|---|---|
| **`/tmp` / `$TMPDIR`** (status quo for code-fixer) | OS auto-cleanup; never git-tracked; no gitignore needed | Lost on reboot (kills resumable long runs); may be a different filesystem; not co-located/visible; not a portable cross-platform concept |
| **`.claude/worktrees/`** (status quo for executors) | Co-located, same filesystem; already covered by #260 path-guard | Claude-Code-specific namespace; not portable to gsd-pi's harness; couples worktree location to one tool |
| **Single shared `.gsd/gsd-worktree/` pool** | Co-located; one directory | One platform's GC can reap the other's live worktree |
| **`.gsd/gsd-worktree/<platform>/`** (chosen) | Co-located & same filesystem (fast adds, no cross-device edge cases); unified under the shared `.gsd` root; platform-neutral; per-platform leaf so GC never crosses platforms; gitignorable; reboot-durable so paused runs resume; visible for debugging; #260 guard extends naturally | Must be gitignored or it pollutes `git status`; nested-worktree-in-repo needs care (already handled for `.claude/worktrees/`); not OS-cleaned — needs explicit lock/heartbeat GC |

**Chosen: `.gsd/gsd-worktree/<platform>/`.** It is the only option that is simultaneously co-located (same filesystem as the repo), reboot-durable, and platform-neutral. The leaf is **namespaced per platform** so each platform's GC operates only on its own worktrees and can never reap a concurrent platform's live worktree.

### Worktree garbage collection — lock/heartbeat

The OS gave `/tmp` free liveness (reboot wipes it); a repo-local directory does not, so GC needs an explicit liveness signal to avoid deleting a worktree a concurrent run is using:

- The owning agent writes a **lock/heartbeat file** into its worktree directory for the duration of its run.
- A **GC sweep runs at the start of any worktree-creating command**, scoped to the current platform's leaf only. It removes an `agent-<id>/` directory only when **both**: (a) its owning branch is merged or absent, **and** (b) its lock is stale/dead.
- **mtime-TTL is a crash backstop** for locks orphaned by a hard kill — not the primary signal.

This was chosen over branch-state-only (cannot distinguish a live-but-unmerged run from an abandoned one) and TTL-only (reaps a long quiet run mid-flight).

## Consequences

- **Positive.** One on-disk contract both platforms honor; a real migration path between them; reboot-durable worktrees on a guaranteed-local filesystem; "where state lives" knowledge concentrated behind one seam; one worktree convention instead of two; per-platform GC isolation.
- **Negative / cost.** A one-time local relocation of `.planning/` (no committed-history break since it is gitignored; mitigated by automatic migration); `.gitignore` and `docs/ARCHITECTURE.md` updates land with the implementation; the `/gsd-pr-branch` filter literal must move in lockstep; new lock/heartbeat GC responsibility for the non-OS-cleaned worktree directory; external references to `.planning/` must be updated.
- **Coordination.** The two platforms must keep the `.gsd/<platform>/` convention in lockstep; this ADR and its gsd-pi sibling (open-gsd/gsd-pi#430) are the coordination record.

## Alternatives considered

- **Keep `.planning/` and `.gsd/` separate (status quo).** Zero migration cost, but permanently forecloses cross-platform interop and leaves no migration path — the core motivation.
- **gsd-core adopts a bare `.gsd/` root (no platform sub-namespace).** Collides head-on with gsd-pi's `.gsd/` and makes dual-hosting impossible. The `gsd-core/`/`gsd-pi/` sub-namespace is what prevents collision.
- **Dual-read or symlink `.planning/` → `.gsd/gsd-core/`** instead of a move. These solve *cross-clone propagation* of a committed path — a problem that does not exist for gitignored local-only state — at the cost of two code paths or cross-platform symlink fragility (Windows, archives, CI). Rejected; a hard local `fs.rename` is strictly simpler.
- **Single shared worktree pool (not per-platform leaf).** Rejected — a shared directory with per-platform GC rules lets one platform's sweep delete the other's live worktree.
- **Worktree GC by branch-state-only or mtime-TTL-only.** Branch-state-only cannot distinguish a live-unmerged run from an abandoned one; TTL-only can reap a long quiet run mid-flight. Rejected as primary signals in favor of lock/heartbeat (TTL kept as a crash backstop).

## References

- ADR-0006 — planning-path-projection-module (the seam this builds on)
- ADR-0008 — installer-migration-module (migration precedent)
- ADR-3660 — runtime-artifact-layout-module
- #260 — worktree absolute-path guard hook
- Sibling enhancement — open-gsd/gsd-pi#430
