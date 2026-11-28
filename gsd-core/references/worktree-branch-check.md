# Worktree branch check (spawn-time guard)

Canonical, fail-closed, **verify-only** guard embedded into every worktree sub-agent
prompt at dispatch. This is the single source of truth for the `worktree_branch_check`
block — do not inline a copy elsewhere. History of coordinated edits: #2924, #2015, #3174, #48.

**Contract for orchestrators:** before dispatch, capture `EXPECTED_BASE=$(git rev-parse HEAD)`,
then embed the block below into the sub-agent prompt verbatim, substituting `{EXPECTED_BASE}`
with that captured SHA. Orchestrators that intentionally create a docs-only pre-dispatch
plan commit may also substitute `{EXPECTED_BASE_ALTERNATE}` with that commit's immediate
parent so runtimes that fork from either side of the docs-only commit pass the same
fail-closed guard (#1265). Otherwise substitute `{EXPECTED_BASE_ALTERNATE}` with an empty
string. The sub-agent only *verifies* and fails closed; the orchestrator (the worktree
lifecycle owner) performs any base recovery — the sub-agent never rewrites a worktree it
did not create (#48).

<worktree_branch_check>
FIRST ACTION: HEAD assertion MUST run before anything else, and this block is
VERIFY-ONLY. Worktrees spawned by Claude Code's `isolation="worktree"` use the
`agent-<id>` namespace (previously `worktree-agent-<id>`; both are accepted). The orchestrator owns this worktree's lifecycle;
a sub-agent MUST NOT hold state-correction primitives (hard-reset, update-ref,
force-move, index-discard) on a worktree it did not create (#48, #2924). Run the
guard below as ONE plain command (#6216). It refuses a detached HEAD, a HEAD on
`main`, `master`, `develop`, `trunk` or `release/*`, a
branch outside the `agent-*` / `worktree-agent-*` / `worktree-wf_*` namespace, and a
HEAD that is neither expected base, and it exits 42 on any of them; a refused
argument exits non-zero too. On any non-zero exit, HALT immediately — surface its
FATAL or Error lines and let the orchestrator (the lifecycle owner) decide recovery. Do NOT self-recover via `git update-ref`, do NOT commit.
```bash
gsd_run query executor.guard --expected-base "{EXPECTED_BASE}" --expected-base-alternate "{EXPECTED_BASE_ALTERNATE}"
```
If `gsd_run` cannot run, check with single commands, each in its own Bash call:
`git symbolic-ref --quiet --short HEAD` must print an `agent-*`, `worktree-agent-*` or
`worktree-wf_*` branch, and `git rev-parse HEAD` must print `{EXPECTED_BASE}` (or a
non-empty `{EXPECTED_BASE_ALTERNATE}`). On any mismatch, HALT as above with exit 42.
</worktree_branch_check>
