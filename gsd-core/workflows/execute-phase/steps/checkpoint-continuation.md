# Checkpoint continuation dispatch (#5212)

6. **Spawn continuation agent (NOT resume) in the original executor worktree** — reuse a non-empty returned `<worktree_metadata>.worktree_path` as its cwd so per-worktree timing and other Git metadata remain available. An empty path means the executor ran in the main checkout: keep the main checkout cwd and do not `cd`. Fail closed only when a returned non-empty path no longer exists — with a prompt built from these placeholders (there is no separate template file; this list is the contract):
   - `{completed_tasks_table}`: Wrap the table from the checkpoint return in `<completed_tasks>...</completed_tasks>`; when empty, still emit `<completed_tasks></completed_tasks>`. Its presence selects continuation. Timing uses the shared Git directory across harness worktrees.
   - `{resume_task_number}` + `{resume_task_name}`: Current task
   - `{user_response}`: What user provided
   - `{resume_instructions}`: Based on checkpoint type
   - `{worktree_path}`: Original executor `<worktree_metadata>.worktree_path`; empty means main checkout, while a non-empty missing path must fail closed
