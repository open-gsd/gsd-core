# ADR-4908: One resolved ProjectContext — which checkout a process acts in is decided once

- **Status:** Accepted — design lock for epic [#4908](https://github.com/open-gsd/gsd-core/issues/4908)
- **Date:** 2026-11-08
- **Issue:** [#6042](https://github.com/open-gsd/gsd-core/issues/6042) — Phase 0 of epic [#4908](https://github.com/open-gsd/gsd-core/issues/4908)
- **Supersedes:** nothing.
- **Relationship to prior work:** extends [ADR-1411](1411-resolution-provenance.md). ADR-1411 gave the project-root walk-up one owner and required resolution to report its provenance. This ADR makes the owner answer a wider question: *which* of several valid roots a process acts in. It reuses the containment predicate from #4636 (`assertWithinRoot`, `src/security.cts`) and leaves #2843's git-boundary rule in force. [#4630](https://github.com/open-gsd/gsd-core/issues/4630) owns the isolation *decision* (whether a process runs in a worktree). This ADR owns the roots that process resolves once the decision has been made.

## Context

A GSD process can have up to four roots that are all valid at the same time:

- the **main checkout**
- the **linked worktree** it runs in
- the directory that holds **`.planning`**, which can be an enclosing workspace
- the real **location of `.planning`**, which can be a symlink into a separate git repository

Each call site picks one. On `next` @ `bcbc1b6f65` the choice is made by:

| Mechanism | Site | Question it actually answers |
|---|---|---|
| `findProjectRoot` | `src/project-root.cts:39`, plus a wrapper at `gsd-core/bin/gsd-tools.cjs:303` | nearest ancestor holding `.planning`, under the #2843 boundary rule and the `planning.sub_repos` / `multiRepo` heuristics |
| `resolveProjectRoot` / `setExplicitProjectRoot` | `src/project-root.cts:29-37` | `--project-dir`, held in a **module-level global** that the dispatcher sets once (#4894) |
| `resolveWorktreeLinkage` / `resolveWorktreeContext` / `resolveWorktreeRoot` | `src/worktree-safety.cts:203,246,3088` | compares git-dir with git-common-dir; for a linked worktree it returns `dirname(git-common-dir)`, which is the **main checkout** |
| `resolveMainWorktreeCwd` | `gsd-core/bin/gsd-tools.cjs:5302` | rewrites the dispatcher's `cwd` *before* any verb runs: unchanged if `cwd/.planning` exists, otherwise whatever `resolveWorktreeRoot` returns |
| `git rev-parse --show-toplevel` | `gsd-core/workflows/_runtime-launcher.snippet.sh` and other workflow shell | the worktree's own top level, used as the root for finding the install |

Seven confirmed bugs came from this: #4885, #4767, #4815, #4834, #4799, #4881 and #4894. All seven were closed by point fixes at the site where each was reported (#5653, #4785, #4819, #4902, #5445, #4921). No owner was added. Two later reports on the epic show the same defect again:

- **`uat.render-checkpoint`** checks a planning artifact's containment against the repo root. Under a symlinked planning store it refuses a legitimate file with "Path escapes allowed directory" (comment on #4908, 2026-09-27).
- **`/gsd-workspace`.** Inside a linked worktree listed in a workspace's `planning.sub_repos`, `resolveMainWorktreeCwd` remaps to the repo's main checkout before `findProjectRoot` runs. The workspace is not an ancestor of the main checkout, so `gsd-tools config-path` prints the main checkout's config with no warning (comment on #4908, 2026-11-02).

#1414 already unified *how far up to walk*. Its guard covers `src/` only and still holds. The defect moved to *which* root, and three of the five mechanisms above are outside `src/`.

## Decision

### 1. One resolver, one value

`src/project-context.cts` exports `resolveProjectContext(startDir, explicit?) → ProjectContext`. It is the only code that resolves a root. The dispatcher calls it once per process and passes the value down. No verb resolves a root for itself.

```ts
interface ProjectContext {
  /** Directory holding the `.planning` entry. Relative planning paths are joined here. */
  readonly projectRoot: string;
  /** Canonical (realpath) location of `.planning`. It differs from projectRoot/.planning when `.planning` is a symlink. */
  readonly planningRoot: string;
  /** Top level of the checkout the process runs in: `git rev-parse --show-toplevel` from startDir. In a linked worktree this is the worktree. */
  readonly worktreeRoot: string;
  /** Top level of the main checkout: the first `worktree` entry of `git worktree list --porcelain`. Equals worktreeRoot outside a linked worktree. */
  readonly repoRoot: string;
  /** Absolute `git rev-parse --git-common-dir`. */
  readonly gitCommonDir: string;
  readonly isLinkedWorktree: boolean;
  readonly provenance: ProjectContextProvenance;
}
```

The epic proposed `{ repoRoot, worktreeRoot, planningRoot, gitCommonDir, isLinkedWorktree, provenance }`. This ADR adds **`projectRoot`** because "where the `.planning` entry is" and "where its content really lives" are different answers under the `gsd-planning-out-of-repo.md` layout. The `uat.render-checkpoint` defect is one consumer needing `planningRoot` while another needs `projectRoot`.

`provenance` uses the ADR-1411 `Resolution<T>` envelope. It records:

- `source` — one of `explicit` (`--project-dir`), `ancestor` (walk-up from startDir), `workspace` (an enclosing `planning.sub_repos` claims the worktree), `main-checkout` (a linked worktree with no reachable `.planning`; see §2.4), or `start-dir` (nothing found)
- `reason`
- `degraded`, which is true when any git query timed out or could not be spawned

Every git subprocess is bounded by the Worktree Safety Policy Module's `DEFAULT_GIT_TIMEOUT_MS` (10 s, `src/worktree-safety.cts:20`) and never throws. On a timeout the resolver degrades to the lexical answer and says so in `provenance`. Callers branch on `provenance`, never on path contents (ADR-1411 rule 2).

### 2. Resolution rules

1. **Linked-worktree subdirectory** (#4885). `worktreeRoot` comes from `--show-toplevel`, which returns the linked worktree from any depth inside it. It is never `dirname(git-common-dir)`. The main checkout is reachable only as `repoRoot`.
2. **Planning store symlinked into its own git repository** (#4815, the `gsd-planning-out-of-repo.md` layout). `projectRoot` is the directory holding the link, and `planningRoot` is its target. The walk-up treats a symlink named `.planning` as a deliberate hop, not a nested-repo boundary (the #4819 rule, absorbed). #2843's boundary rule is otherwise unchanged.
3. **Workspaces.** The ancestor walk runs from `startDir` itself, so a `planning.sub_repos` workspace enclosing the linked worktree is found by the existing sub-repos heuristic. `source: workspace` is recorded. There is no remap to the main checkout before the walk, which is what made the workspace unreachable.
4. **Linked worktree with no reachable `.planning`.** This is the case `resolveMainWorktreeCwd` existed for: an agent worktree whose `.planning` is untracked and lives only in the main checkout. The walk finds nothing inside `worktreeRoot`, so the resolver repeats it from `repoRoot`. `projectRoot` / `planningRoot` point into the main checkout with `source: main-checkout`, while `worktreeRoot` stays the worktree. Planning writes land in the main checkout as they do today. Code and git operations do not.
5. **`--project-dir`** (#4894). The value goes into the context as `source: explicit`, so it is no longer a global. Every consumer reads it from the context, and a code path that derives a root from something else (a phase directory, a file path) gets a ready-made context instead. A path that cannot honor it refuses with a typed reason rather than ignoring it.
6. **Not a git repository.** `worktreeRoot` and `repoRoot` are the lexical start directory, `gitCommonDir` is empty, `isLinkedWorktree` is false, and `provenance.reason` says `not_git_repo`. The planning walk-up still runs. A committing verb refuses.

### 3. Callers name the root they mean

There is no field called `root` or `cwd`. Each consumer picks one of these:

| Intent | Field |
|---|---|
| run git, run a verify command, resolve a code path, commit | `worktreeRoot` |
| join a relative `.planning/...` path, load config | `projectRoot` |
| containment of a planning artifact (`requireSafePath` on `.planning` content) | `planningRoot` |
| shared history: the base branch, `worktree list`, the install that serves every worktree | `repoRoot` / `gitCommonDir` |

A caller that legitimately needs the main checkout from inside a worktree (worktree inventory and pruning, for example) asks for `repoRoot` by name. That is the named special case the epic anticipated, and it is the only way to reach the main checkout.

Rule for **committing verbs**: a commit runs in `worktreeRoot`. A path to commit that resolves outside `worktreeRoot` refuses with a typed reason (`outside_worktree`) and `committed: false`. It is never redirected to another repository. Under §2.4, planning files outside the worktree are therefore refused by a committing verb run from the worktree, not committed into the main checkout behind the caller's back.

### 4. One containment predicate for execution targets (#4767)

`assertWithinRoot` / `tryWithinRoot` (`src/security.cts`) also own containment for **execution targets**: the directory a `cd` inside a verify command lands in, absolute or relative, checked against `ctx.worktreeRoot`. `verify-command-grounding` reports `outside_root` for an absolute target exactly as it already does for a relative one. Quick mode runs the probe. The executor's guard covers `<automated>` execution as well as Edit/Write.

This is a **warning, never a blocker**: a false blocker is "worse than the bug this feature fixes" (#3678). #2401 Finding 3 stays (a chained `cd` resets on an absolute segment). The one assertion that flips is #2401's `severity: 'none'` for an absolute directory outside the fixture root.

### 5. Tool resolution is part of the context (#4834, #4799, #4881)

`gsd_run` resolves candidates in this order:

1. the install under `worktreeRoot`
2. the install under `repoRoot`
3. the runtime config homes
4. `PATH`, last and identity-checked

The snippet today derives its only local candidate from `--show-toplevel`. Inside a linked worktree that has no `gsd-core/` of its own, it therefore skips the main checkout's local install and can fall through to a global copy. Candidate 2 closes that gap. The snippet and any JS-side tool lookup encode one order and share a parity test.

### 6. The ratchet

The first two decisions undo themselves quietly unless they are enforced by construction:

- **Typed `cwd`.** Migrated verbs take `ctx: ProjectContext`, not `cwd: string`, so a hand-resolved string root does not typecheck.
- **Lint.** An ESLint rule rejects `findProjectRoot`, `resolveWorktreeLinkage`, and `rev-parse` argv containing `--show-toplevel` or `--git-common-dir` anywhere except `src/project-context.cts`, across `src/`, `gsd-core/bin/` and `hooks/`. A companion check over shipped workflow shell rejects raw `git rev-parse --show-toplevel` root resolution outside the launcher snippet. Workflows obtain roots from `gsd_run query project-context`. #1414's grep guard is folded into the rule.
- **Positive controls.** Every verb that takes a context is run from a subdirectory of a linked worktree and must act in that worktree or refuse. A parity test fails when a verb is added without a control. That harness did not exist before, which is why #4885, #4799 and #4881 shipped.

## Phase map

Every "Done when" item on #4908 is claimed by exactly one phase.

| Phase | Issue | Delivers | Claims (#4908 "Done when") |
|---|---|---|---|
| 0 | [#6042](https://github.com/open-gsd/gsd-core/issues/6042) | this ADR | — (design lock) |
| 1 | [#6043](https://github.com/open-gsd/gsd-core/issues/6043) | `src/project-context.cts`, `query project-context`, worktree-subdirectory harness; `resolveMainWorktreeCwd` and `setExplicitProjectRoot` deleted; `findProjectRoot` / `resolveWorktreeLinkage` internal to the seam; workspace rule §2.3 | one resolver · a committing verb from any depth commits in that worktree or refuses (#4885 reproducer) · symlinked planning store resolves correctly · `--project-dir` carried in the context and honored or refused · failing-first regressions for #4885, #4815, #4894 |
| 2 | [#6044](https://github.com/open-gsd/gsd-core/issues/6044) | census and migration of every git invocation and filesystem write in `src/` and `gsd-tools.cjs` to a named context field; typed `ctx`; planning containment on `planningRoot` | every git invocation and filesystem write takes its `cwd` from a named field |
| 3 | [#6045](https://github.com/open-gsd/gsd-core/issues/6045) | §4 | `cd` target outside the worktree root warns, absolute or relative, and the probe runs in quick mode · failing-first regression for #4767 |
| 4 | [#6046](https://github.com/open-gsd/gsd-core/issues/6046) | §5 | `gsd_run` resolves install-local before `PATH`, including from a linked worktree · failing-first regressions for #4834, #4799, #4881 |
| 5 | [#6047](https://github.com/open-gsd/gsd-core/issues/6047) | §6 lint and shell check, positive-control parity | lint over `src/`, `bin/`, `hooks/` and workflow shell · a positive control from a linked-worktree subdirectory for every `cwd`-taking verb |

The phases are stacked in that order. Phases 3 and 4 depend only on Phase 1, and Phase 5 depends on all of them. The epic stays open until Phase 5 merges.

## Consequences

### Bug classes avoided

- **Wrong-repository writes.** No call site can ask for "the root" and get the main checkout. The main checkout must be requested by name.
- **Verification against the wrong tree.** An execution target outside the worktree is visible.
- **Layout-specific misresolution.** Symlinked stores, workspaces and `--project-dir` are rules inside one resolver, each with a regression test, instead of patches at the site that happened to be reported.
- **Resolver drift.** A sixth resolver fails lint wherever it is written.

### Cost

- A wide but mechanical migration (Phase 2) touching most verbs' signatures.
- One extra git query per process (`worktree list`) for `repoRoot`, bounded and degradable.

### Tradeoff

Under §2.4, a committing verb run from a linked worktree whose planning content lives only in the main checkout now **refuses** to commit those planning files, where it used to commit them into the main checkout. That is the contract the epic asks for: commit there or refuse, never elsewhere. Workflows that need such a commit run it with the main checkout as `startDir`.

## Alternatives considered

- **Keep fixing at the reported site.** This was done seven times and the defect reappeared in a resolver the previous guard could not see. Rejected by the epic's own non-goals.
- **Keep the epic's six fields.** `planningRoot` would then have to mean either "holds the `.planning` entry" or "where `.planning` really lives". Either choice breaks one of the reported consumers. Rejected in favor of adding `projectRoot`.
- **Make `findProjectRoot` worktree-aware in place.** This keeps one function name but still returns a bare string, so callers would still choose a root implicitly and nothing would typecheck the choice. Rejected.
- **Blocker severity for an outside `cd` target.** Rejected by #3678 and by the epic's non-goals.
- **Let the git-boundary rule permit crossing into symlinked stores in general.** That would reopen #2843 through another trigger. Only a symlink named `.planning` is treated as a hop.
