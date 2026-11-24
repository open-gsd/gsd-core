# ADR-6216: Executor worktree guards and the plan commit ledger as single commands [Proposed]

- **Status:** Proposed. Implemented in `src/executor-guard.cts` and routed as `query executor.guard` and `query executor.ledger`; the maintainer's approval of #6216 made the ledger's storage location a condition, recorded here.
- **Date:** 2026-11-24
- **Issue:** [#6216](https://github.com/open-gsd/gsd-core/issues/6216). Approved as a feature with three conditions: the guards stay verify-only and fail closed (#48); the ledger's storage outside the shared `.git/worktrees/` path is specified in an ADR; the reporter supplies the refused commands.
- **Relationship to prior work:** [ADR-4908](4908-project-context.md) gives every router the resolved `ProjectContext`; these verbs read its `worktreeRoot`. [ADR-4630](4630-dispatch-identity-and-isolation-decision-seam.md) moved the dispatch-side isolation decision into `query dispatch-isolation`; this ADR does the same for the executor side and changes neither.
- **Scope:** the executor's spawn-time `worktree_branch_check`, its pre-commit checks (steps 0a, 0b and 0) and its plan commit ledger (step 0c and the SUMMARY's `commits:` measurement). Multi-repo `commit-to-subrepo` hashes are unchanged.

## Context

Under Claude Code's worktree isolation, the permission layer refuses some Bash commands that name `git` as too complex to verify. The reporter's transcripts on #6216 show it refusing the `worktree_branch_check` block, the step 0c ledger write, and a verify loop over `git diff`. The Write tool also refuses the ledger file, because `.git/worktrees/<name>/` is outside the worktree. Which shapes are refused has changed between releases.

When those blocks are refused, an executor splits them up by hand or skips them. A guard that runs only when its exact shell text runs is then no guard, and a skipped ledger turns the SUMMARY's measured `commits:` back into a narrated one (#3968).

## Decision

### 1. Each guard is one command that verifies and fails closed

`gsd_run query executor.guard [--expected-base <sha>] [--expected-base-alternate <sha>] [--toplevel <path>] [--path <path>] [--sequential]` runs, in one process, the checks the shell blocks ran:

| Check | Fails when | Replaces |
|---|---|---|
| `head-attached` | HEAD is detached or does not resolve | `worktree_branch_check`, step 0 |
| `not-protected` | the branch is protected or the default branch, or the base branch cannot be verified (`resolveProtectedBranchStatus`, the `git.base-branch --is-protected` rule) | step 0 |
| `agent-namespace` | the branch is outside `agent-*` / `worktree-agent-*` / `worktree-wf_*`; checked whenever `--expected-base` is given, and in a linked worktree unless `--sequential` | `worktree_branch_check`, step 0 |
| `base` | HEAD is neither `--expected-base` nor a non-empty `--expected-base-alternate` | `worktree_branch_check` |
| `toplevel` | the worktree root of the current directory is not `--toplevel` | step 0a |
| `path` | `--path` (absolute, or relative to the current directory) lands outside the worktree root | step 0b |

The verb reads HEAD, the branch and the worktree root, and writes nothing. It prints its checks as JSON, prints a `FATAL:` line on stderr for each failed check, and exits 42, the `worktree_branch_check` contract's code. Recovery stays with the orchestrator that owns the worktree (#48).

### 2. The ledger lives in the worktree's tool-owned `.gsd/` directory

`gsd_run query executor.ledger record --phase <phase> --plan <plan>` writes `<worktree root>/.gsd/executor-ledger/<phase>-<plan>.json`:

```json
{ "schema": 1, "phase": "02", "plan": "04", "plan_head_before": "<sha>", "branch": "agent-…", "recorded_at": "<ISO time>" }
```

- **Root.** The worktree root is the dispatcher's `ProjectContext.worktreeRoot`, the top level of the checkout the command runs in. It is never the project root: a linked worktree whose `.planning/` is untracked has the main checkout as its project root, and the ledger must not land there.
- **Directory.** `.gsd/` is created through `ensureToolOwnedGsdDir`, which refuses a symlinked or escaping `.gsd` and seeds `.gsd/.gitignore` so the record never shows in `git status`. The dispatch sentinel uses the same directory in the same way.
- **Once.** The file is created with an exclusive open, and a later `record` for the same plan keeps the first base. The executor may run `record` before every commit.
- **Names.** `--phase` and `--plan` must be plain ids (letters, digits, `.`, `_`, `-`, not starting with `.`), so a record cannot leave the directory.
- **Lifetime.** The record is removed with the worktree.

`gsd_run query executor.ledger read --phase <phase> --plan <plan>` prints `plan_head_before`, `plan_head_after` and `commits` (`git rev-list --count <base>..HEAD`). It exits 1 when the record is missing, unreadable, or its base is not an ancestor of HEAD; it never counts from a base it cannot trust.

### 3. A named fallback when a verb cannot run

When `gsd_run` cannot run, or `executor.ledger record` fails, the executor takes the base from the `{EXPECTED_BASE}` its dispatch prompt carried, and checks the root and the branch with single commands (`git rev-parse --show-toplevel`, `git rev-parse --abbrev-ref HEAD`), each in its own Bash call. The SUMMARY then records that base as `plan_head_before:`.

### 4. One git command per Bash call

The executor runs each git command on its own, and the planner writes `<automated>` verify steps as single commands: one `git diff --name-only <base> -- <paths…>` in place of a loop over paths.

## Alternatives considered

- **Keep the ledger in `.git/worktrees/<name>/`, written by the verb.** A process can write there, but the maintainer asked for storage outside that shared path, and the Write tool fallback still cannot reach it.
- **A per-worktree git ref (`refs/worktree/…`).** Git stores those under `.git/worktrees/<name>/` too, and writing refs is the kind of primitive #48 keeps away from a sub-agent.
- **A store under the user's home, keyed by worktree path.** It outlives the worktree and needs its own cleanup, and a later worktree at the same path would read a stale base.

## Consequences

- The shell blocks in `agents/gsd-executor.md` and `gsd-core/references/worktree-branch-check.md` become single `gsd_run` lines, and the executor file shrinks.
- `.gsd/` in a worktree now holds an `executor-ledger/` directory beside any dispatch records.
