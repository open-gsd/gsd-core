---
type: Changed
pr: 590
---
**Worktree base checks are now verify-only and fail-closed** — a GSD executor sub-agent no longer runs `git reset --hard` to self-correct a mismatched worktree base (which could fail silently under a `git reset --hard` deny rule and risk a wrong-base merge of unrelated files). On a base or HEAD-namespace mismatch the sub-agent now halts with `exit 42` and hands recovery to the orchestrator (the worktree lifecycle owner). The orchestrator also guards against cwd drift into an agent worktree at `execute_waves` entry.
