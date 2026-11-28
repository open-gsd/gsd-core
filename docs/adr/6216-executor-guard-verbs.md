# ADR-6216: Executor worktree guards and the plan commit ledger as single commands [Proposed]

- **Status:** Proposed. Implemented in `src/executor-guard.cts` and routed as `query executor.guard` and `query executor.ledger`; the maintainer's approval of #6216 made the ledger's storage location a condition, recorded here.
- **Date:** 2026-11-24
- **Issue:** [#6216](https://github.com/open-gsd/gsd-core/issues/6216). Approved as a feature with three conditions: the guards stay verify-only and fail closed (#48); the ledger's storage outside the shared `.git/worktrees/` path is specified in an ADR; the reporter supplies the refused commands.
- **Relationship to prior work:** [ADR-4908](4908-project-context.md) gives every router the resolved `ProjectContext`; these verbs take its `projectRoot` for configuration and read the worktree from the directory the command ran in. [ADR-4630](4630-dispatch-identity-and-isolation-decision-seam.md) moved the dispatch-side isolation decision into `query dispatch-isolation`; this ADR does the same for the executor side and changes neither.
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
| `not-protected` | with `--expected-base`: the branch is `main`, `master`, `develop`, `trunk` or `release/*`, as in the spawn-time block. Otherwise: the branch is protected or the default branch, or the base branch cannot be verified (`resolveProtectedBranchStatus`, the `git.base-branch --is-protected` rule) | `worktree_branch_check`, step 0 |
| `agent-namespace` | the branch is outside `agent-*` / `worktree-agent-*` / `worktree-wf_*`; checked whenever `--expected-base` is given, and otherwise unless `--sequential` in a worktree whose `.git` is a file or whose git dir is not the common dir (a linked worktree, a submodule, a separate git dir; `.git` is followed when it is a link), or whose layout cannot be read | `worktree_branch_check`, step 0 |
| `base` | HEAD is neither `--expected-base` nor a non-empty `--expected-base-alternate`, or `--expected-base-alternate` is given without `--expected-base` | `worktree_branch_check` |
| `toplevel` | the worktree root of the current directory is not `--toplevel`, both resolved | step 0a |
| `path` | `--path` (absolute, or relative to the current directory), resolved one segment at a time with each link followed, lands outside the worktree root; or it cannot be resolved (a link that does not resolve, a segment, `.` or trailing separator below a file, `..` below a missing segment). On POSIX only `/` separates segments | step 0b |

Given `--path` with none of `--toplevel`, `--expected-base` and `--expected-base-alternate`, the verb runs the `path` check alone, as the step 0b block did: `head-attached`, `not-protected` and `agent-namespace` are run by the spawn-time and pre-commit calls. `--sequential` on such a call changes nothing, so it is refused as a usage error, and `--expected-base-alternate` (empty or not) makes the call a branch-checking one.

The verb reads the worktree of the directory it runs in, its HEAD and branch, and writes nothing. It prints its checks as JSON, prints a `FATAL:` line on stderr for each failed check, and exits 42, the `worktree_branch_check` contract's code; a git call the seam stops (its timeout or a signal) is named in the failed checks. An argument the parser refuses exits with its usage code, so the step texts halt on any non-zero exit, except that a pre-commit call whose only failed check is `toplevel` is re-run from the kept worktree root. Recovery stays with the orchestrator that owns the worktree (#48).

### 2. The ledger lives in the worktree's `.gsd/executor-ledger/` directory

`gsd_run query executor.ledger record --phase <phase> --plan <plan>` writes `<worktree root>/.gsd/executor-ledger/<phase>+<plan>.json`:

```json
{ "schema": 1, "phase": "02", "plan": "04", "plan_head_before": "<sha>", "branch": "agent-…", "recorded_at": "<ISO time>" }
```

- **Root.** The worktree root is the top level of the checkout the command runs in. It is never the project root: a linked worktree whose `.planning/` is untracked has the main checkout as its project root, and the ledger must not land there.
- **Directory.** `.gsd/` and `.gsd/executor-ledger/` must be real directories at exactly those paths, not links. `executor-ledger/` carries its own `.gitignore` (`*`), so its files stay out of `git status` whatever `.gsd/.gitignore` says, and `.gsd/.gitignore` is never edited. The record itself must be a regular file.
- **Once.** The record is written whole to a temporary name and hard-linked into place, which fails when it already exists; a later `record` for the same plan keeps the first base. The executor may run `record` before every commit.
- **Names.** `--phase` and `--plan` must be plain ids (a letter or digit, then letters, digits, `.`, `_`, `-`; at most 64 characters, so the file name stays well inside a 255-byte limit). A record larger than 4096 bytes is refused unread. `+` joins them in the file name and is outside that alphabet, so two pairs never share a record, and the record's own `phase` and `plan` must match.
- **Lifetime.** In a linked worktree, the record is removed with the worktree.

`gsd_run query executor.ledger read --phase <phase> --plan <plan>` prints `plan_head_before`, `plan_head_after` and `commits` (`git rev-list --count <base>..HEAD`). It exits 1 when the record is missing, unreadable or not this plan's, or its base is not a commit or not an ancestor of HEAD.

### 3. A named fallback when a verb cannot run

When `gsd_run` cannot run, the executor checks the root and the branch with single commands (`git rev-parse --show-toplevel`, `git symbolic-ref --quiet --short HEAD`), each in its own Bash call. The root it compares against is the plan's first `git rev-parse --show-toplevel` output, from step 0 or step 0b, whichever runs first, kept as a literal. For step 0b it uses a relative path, and an absolute one only when it begins with that root followed by a path separator and has no `.` or `..` segment; otherwise it halts. When `executor.ledger record` fails, it takes the base from the `head` its first `executor.guard` run printed before the first commit (or a `git rev-parse HEAD` run then) and keeps it as a literal; the SUMMARY records that base as `plan_head_before:`.

### 4. One git command per Bash call

The executor runs each git command it composes on its own, and the planner writes `<automated>` verify steps as single commands: one `git diff --quiet -- <paths…>` in place of a loop of `git diff --quiet -- <path>`.

## Alternatives considered

- **Keep the ledger in `.git/worktrees/<name>/`, written by the verb.** A process can write there, but the maintainer asked for storage outside that shared path, and the Write tool fallback still cannot reach it.
- **A per-worktree git ref (`refs/worktree/…`).** Git stores those under `.git/worktrees/<name>/` too, and writing refs is the kind of primitive #48 keeps away from a sub-agent.
- **A store under the user's home, keyed by worktree path.** It outlives the worktree and needs its own cleanup, and a later worktree at the same path would read a stale base.

## Consequences

- The shell blocks in `agents/gsd-executor.md` and `gsd-core/references/worktree-branch-check.md` become single `gsd_run` lines, and the executor file shrinks.
- `.gsd/` in a worktree now holds an `executor-ledger/` directory beside any dispatch records.
