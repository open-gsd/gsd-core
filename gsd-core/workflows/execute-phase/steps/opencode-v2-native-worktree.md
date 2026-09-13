# OpenCode V2 native worktree lifecycle

Read this fragment only when `EXEC_JSON.exec.transport == "native-tool"`. The exact
descriptor-selected `gsd_worktree_task` is the only permitted native transport. Do
not substitute `opencode run`, detached sessions, `session_move`, Bash polling, or
a legacy `wait` action.

## Parent and round identity

Before a native side effect, prove the canonical orchestrator checkout and resume
the same parent session in that project. The current parent calls `recover`; never
guess a parent/session, directory, manifest, or agent identity. A notification is
only a wake-up signal, never recovered status, job selection, or merge authority.
If identity cannot be proved after OpenCode/OpenChamber restart, halt and preserve
the manifest worktrees.

## Start and exact seal

Use one stable unique `wave_id` per GSD phase wave. For every manifest-recorded
worktree, call only `gsd_worktree_task` `start` with that exact wave id, canonical
worktree directory, exact `$WAVE_WORKTREE_MANIFEST`, manifest agent id, composed
executor prompt, `agent: gsd-executor`, explicit provider and bare model fields,
configured reasoning effort `medium` or `high`, title, and bounded timeout.

Retain each returned `{session_id,directory,manifest_path,manifest_agent_id}` and
validate it against the start coordinates. After all accepted same-wave starts,
call `seal` exactly once with the exact complete returned `{session_id,directory}`
set. Never seal a subset or one job at a time. Do not call `status` in the same
turn after seal; end the turn and resume from a completion notification or explicit
user resume. Reconciliation is idempotent: after a crash, `recover` the same
parent and compare only exact returned identities before resuming a missing phase.

## Fresh merge gate and ordered teardown

Immediately before entering the existing merge gauntlet, the current parent calls
`recover`, then `status` for the exact sealed `wave_id`. The model must literally
observe fresh `merge_ready:true`; reconcile the complete sealed job set and exact
start/session/canonical-directory/manifest identities before selecting a plan.
Prior status, SUMMARY files, child prose, or notifications are not authority.

Merge every same-wave worktree through the existing manifest-scoped gauntlet before
removing any of them. After removal begins, do not request another wave status.
Use manifest-only cleanup; never broad/glob cleanup. Process descriptors retain
the documented command, args, cwd, and wait behavior in
`executor-isolation-dispatch.md` unchanged.
