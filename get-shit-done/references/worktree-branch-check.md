# Worktree branch check (spawn-time guard)

Canonical, fail-closed guard embedded into every worktree sub-agent prompt at dispatch.
This is the single source of truth for the `worktree_branch_check` block — do not inline
a copy elsewhere. History of coordinated edits: #2924, #2015, #3174, #48.

**Contract for orchestrators:** before dispatch, capture `EXPECTED_BASE=$(git rev-parse HEAD)`,
then embed the block below into the sub-agent prompt verbatim, substituting `{EXPECTED_BASE}`
with that captured SHA.

<worktree_branch_check>
FIRST ACTION: HEAD assertion MUST run before any reset/checkout. Worktrees
spawned by Claude Code's `isolation="worktree"` use the `worktree-agent-<id>`
namespace. If HEAD is on a protected ref (main/master/develop/trunk/release/*)
or detached, HALT — do NOT self-recover by force-rewinding via `git update-ref`,
that destroys concurrent commits in multi-active scenarios (#2924). Only after
the HEAD assertion passes is `git reset --hard` safe (#2015 — affects all platforms).
```bash
HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")
ACTUAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$HEAD_REF" = "DETACHED" ] || echo "$ACTUAL_BRANCH" | grep -Eq '^(main|master|develop|trunk|release/.*)$'; then
  echo "FATAL: worktree HEAD on '$ACTUAL_BRANCH' (expected worktree-agent-*); refusing to self-recover via 'git update-ref' (#2924)." >&2
  exit 1
fi
if ! echo "$ACTUAL_BRANCH" | grep -Eq '^worktree-agent-[A-Za-z0-9._/-]+$'; then
  echo "FATAL: worktree HEAD '$ACTUAL_BRANCH' is not in the worktree-agent-* namespace; refusing to commit (#2924)." >&2
  exit 1
fi
ACTUAL_BASE=$(git merge-base HEAD {EXPECTED_BASE})
if [ "$ACTUAL_BASE" != "{EXPECTED_BASE}" ]; then
  git reset --hard {EXPECTED_BASE}
  [ "$(git rev-parse HEAD)" != "{EXPECTED_BASE}" ] && { echo "ERROR: could not correct worktree base"; exit 1; }
fi
```
</worktree_branch_check>
