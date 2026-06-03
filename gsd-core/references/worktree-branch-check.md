# Worktree branch check (spawn-time guard)

Canonical, fail-closed, **verify-only** guard embedded into every worktree sub-agent
prompt at dispatch. This is the single source of truth for the `worktree_branch_check`
block — do not inline a copy elsewhere. History of coordinated edits: #2924, #2015, #3174, #48.

**Contract for orchestrators:** before dispatch, capture `EXPECTED_BASE=$(git rev-parse HEAD)`,
then embed the block below into the sub-agent prompt verbatim, substituting `{EXPECTED_BASE}`
with that captured SHA. The sub-agent only *verifies* and fails closed; the orchestrator
(the worktree lifecycle owner) performs any base recovery — the sub-agent never rewrites a
worktree it did not create (#48).

<worktree_branch_check>
FIRST ACTION: HEAD assertion MUST run before anything else, and this block is
VERIFY-ONLY. Worktrees spawned by Claude Code's `isolation="worktree"` use the
`worktree-agent-<id>` namespace. The orchestrator owns this worktree's lifecycle;
a sub-agent MUST NOT hold state-correction primitives (hard-reset, update-ref,
force-move, index-discard) on a worktree it did not create (#48, #2924). If ANY
assertion below fails, HALT immediately — print the FATAL line, `exit 42`, and let
the orchestrator (the lifecycle owner) decide recovery. Do NOT self-recover, do NOT
commit.
```bash
HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")
ACTUAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$HEAD_REF" = "DETACHED" ] || echo "$ACTUAL_BRANCH" | grep -Eq '^(main|master|develop|trunk|release/.*)$'; then
  echo "FATAL: worktree HEAD on '$ACTUAL_BRANCH' (expected worktree-agent-*); refusing to commit or self-recover via 'git update-ref' (#2924)." >&2
  exit 42
fi
if ! echo "$ACTUAL_BRANCH" | grep -Eq '^worktree-agent-[A-Za-z0-9._/-]+$'; then
  echo "FATAL: worktree HEAD '$ACTUAL_BRANCH' is not in the worktree-agent-* namespace; refusing to commit (#2924)." >&2
  exit 42
fi
if [ "$(git rev-parse HEAD)" != "{EXPECTED_BASE}" ]; then
  echo "FATAL: worktree base mismatch — HEAD is $(git rev-parse HEAD), expected {EXPECTED_BASE}. Orchestrator owns recovery; sub-agent refuses to rewrite the worktree (#48)." >&2
  exit 42
fi
```
</worktree_branch_check>
