# Native session-tracked dispatch backend for OpenCode executors

**Source:** [#6435](https://github.com/open-gsd/gsd-core/issues/6435)
**Decision:** wontfix — No-go as filed for the native backend; the worktree-root setting and the process-mode failures it reported stay welcome as separate issues
**Date:** 2026-11-20

## Proposal summary

Reporter proposed two related changes for OpenCode execution. First, a **native, session-tracked dispatch mode** alongside the existing PID-tracked process mode: keep the worktree preparation, base pin, manifest bookkeeping, artifact reconciliation and guarded merge as they are, but dispatch each executor through the host's subagent tool and track the child by its session ID, resolving one executor backend per host. Second, a **configurable executor worktree root outside the orchestrator checkout**, applied to creation, `worktree.worker-*` lookup and recovery. The report cites failures it observed in the process mode on OpenCode with a desktop client on Windows: a ~240 KB composed prompt that cannot pass as a command-line argument, upstream timeouts when the CLI is bound to the client's server, a false idle status on the default server, recovery on the session's original model instead of the current pin, and a folder-trust refusal for worktrees nested under the checkout.

## Why GSD does not own this

- **A second core-resident dispatch backend is a permanent tax.** The shipped `orchestrator-worktree` mode spawns the worker as a background process and tracks it by PID (`gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md`). A native backend would be a second path through the same executor lifecycle, so every later change to preparation, reconciliation, recovery or merge would be made twice or proven to apply to both. The isolation resolver's blast radius was rated Medium when the same ground was decided for Codex, and `dispatch.isolation` is declared across several runtime capability descriptors, so a backend is a multi-descriptor change.
- **Same decision, different host.** [`codex-native-supervisor-adapter.md`](./codex-native-supervisor-adapter.md) (#4625) declined a core-resident adapter around a host's native subagent view. Its decisive ground was Codex's fixed status enum, which does not apply to OpenCode; its dispatch-tax ground is host-independent and is the ground here.
- **The sanctioned path for session visibility is an EoS capability.** Once a durable per-worker record exists, a capability can read it at the wave boundaries (`execute:wave:pre` / `execute:wave:post`, ADR-857's loop extension points) and report each worker's state with no core change.

Note what the proposal got **right**, none of which is a ground for rejection: the failures it reports were observed empirically and are specific; it keeps GSD's reconciliation rule (SUMMARY, plan-scoped commits and branch state, never an exit code or status badge alone); and it separates the worktree-root change from the backend change.

## What this does NOT cover

This entry denies **gsd-core adding a second, native session-tracked dispatch backend for OpenCode (or any host)**. Its keyword surface (OpenCode, dispatch, worktree, executor, session, subagent) overlaps requests this decision does not deny. Do not apply it to:

- **A configurable executor worktree root outside the checkout** for the existing process mode, applied to creation, `worker-*` lookup and recovery. That is a setting on the shipped adapter.
- **Defects in the shipped process mode on OpenCode**: delivering a prompt too large for a Windows command line, recovery that ignores the agent file's current model pin, the nested-worktree trust refusal. Each is a bug report, one per defect.
- **Worker-state visibility as a goal**, through an EoS capability reading a persisted worker record.
- **OpenCode runtime support generally.**

## Re-open criteria

- A resubmission names a specific residual failure observed after the process-mode defects above were fixed and the EoS read-and-report path was tried, and shows that no process-mode change can address it.
- Or the dispatch lifecycle is reduced to one backend-neutral seam, so that a second backend adds no second copy of preparation, reconciliation, recovery and merge.

## Related

- [`codex-native-supervisor-adapter.md`](./codex-native-supervisor-adapter.md): the earlier decision on the same class of request
- [`subagent-activity-watchdog.md`](./subagent-activity-watchdog.md): denies a generalized event-driven watchdog, preserves narrow per-spawn-site work
- [ADR-857](../docs/adr/857-capability-system.md): the capability system and its loop extension points
- [ADR-4630](../docs/adr/4630-dispatch-identity-and-isolation-decision-seam.md): the dispatch identity and isolation decision seam
- [#6435](https://github.com/open-gsd/gsd-core/issues/6435): the issue this was decided on
