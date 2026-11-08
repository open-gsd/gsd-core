# ADR-4908: One resolved ProjectContext — which checkout a process acts in is decided once

- **Status:** Proposed — design lock for epic [#4908](https://github.com/open-gsd/gsd-core/issues/4908). Ratified to Accepted at the Phase 5 closeout ([#6047](https://github.com/open-gsd/gsd-core/issues/6047)), once every phase in the map below has shipped ([README rule 3](README.md)).
- **Date:** 2026-11-08
- **Issue:** [#6042](https://github.com/open-gsd/gsd-core/issues/6042) — Phase 0 of epic [#4908](https://github.com/open-gsd/gsd-core/issues/4908)
- **Supersedes:** nothing.
- **Relationship to prior work:** builds on [ADR-1411](1411-resolution-provenance.md) and is **not** an amendment of it. ADR-1411 gave the project-root walk-up one owner and required resolution to report its provenance. This ADR applies that principle to a wider question: *which* of several valid roots a process acts in. It reuses the containment predicates from #4636 (`src/security.cts`) and keeps #2843's git-boundary rule in force. [#4630](https://github.com/open-gsd/gsd-core/issues/4630) owns the isolation *decision* (whether a process runs in a worktree), and this ADR owns the roots the process resolves once that decision is made. The verification epic #4907, which absorbed #4894, was itself subsumed by [ADR-5057](5057-one-owner-per-workflow-verdict.md) Arm B. That arm's `--project-dir` constraint (§3.1, phase artifacts may live outside `projectRoot`) is satisfied here by `planningRoot`.

## Context

A GSD process can have up to four roots that are all valid at the same time:

- the **main checkout**
- the **linked worktree** it runs in
- the directory that holds the **`.planning` entry**, which can be an enclosing workspace
- the real **location of `.planning`**, which can be a symlink into a separate git repository

Each call site picks one. On `next` @ `bcbc1b6f65` the choice is made by:

| Mechanism | Site | What it answers |
|---|---|---|
| `findProjectRoot` | `src/project-root.cts:39`, plus a wrapper at `gsd-core/bin/gsd-tools.cjs:303` | nearest ancestor holding `.planning`, applying the #2843 boundary rule, the symlinked-`.planning` hop (#4815) and the `planning.sub_repos` / `multiRepo` heuristics |
| `resolveProjectRoot` / `setExplicitProjectRoot` | `src/project-root.cts:29-37` | `--project-dir`, held in a **module-level global** that the dispatcher sets once (#4894) |
| `resolveWorktreeLinkage` | `src/worktree-safety.cts:203` | compares git-dir with git-common-dir. For a linked worktree it returns `dirname(git-common-dir)`, which is the **main checkout** |
| `resolveWorktreeContext` / `resolveWorktreeRoot` | `src/worktree-safety.cts:246,3088` | `cwd` when it has `.planning`. Otherwise, from inside a linked worktree, that worktree's top level when the top level has `.planning` (the #4885 fix), and the main checkout when it does not |
| `resolveMainWorktreeCwd` | `gsd-core/bin/gsd-tools.cjs:5302` | rewrites the dispatcher's `cwd` *before* any verb runs: unchanged when `cwd/.planning` exists, otherwise whatever `resolveWorktreeRoot` returns |
| `RUNTIME_DIR` or `git rev-parse --show-toplevel` | `gsd-core/workflows/_runtime-launcher.snippet.sh` | the one root under which the launcher looks for a local install |

Seven confirmed bugs came from this. The epic's table lists six of them: #4885, #4767, #4815, #4834, #4799 and #4881. The seventh, #4894, it names separately. All seven are closed by point fixes at the site where each was reported, in six PRs because #4819 closed both #4815 and #4894: #5653, #4785, #4819, #4902, #5445 and #4921. None of these fixes added an owner. Two later reports on the epic show the same defect again:

- **`uat.render-checkpoint`** checks a planning artifact's containment against the repo root. Under a symlinked planning store it refuses a legitimate file with "Path escapes allowed directory" (comment on #4908, 2026-09-27).
- **`/gsd-workspace`.** Inside a linked worktree listed in a workspace's `planning.sub_repos`, the worktree has no `.planning` of its own, so `resolveMainWorktreeCwd` remaps to the repo's main checkout before `findProjectRoot` runs. The workspace is not an ancestor of the main checkout. `gsd-tools config-path` therefore prints the main checkout's config, with no warning (comment on #4908, 2026-11-02).

#1414 already unified *how far up to walk*. Its guard covers `src/` only, and it still holds. The defect moved to *which* root, and two of the mechanisms above are outside `src/`.

## Decision

### 1. One resolver, one value

`src/project-context.cts` exports `resolveProjectContext(startDir, explicit?) → ProjectContext`. It is the only code that resolves a root. The dispatcher calls it once per process and passes the value down, and no verb resolves a root for itself.

```ts
interface ProjectContext {
  /** Directory holding the `.planning` entry. CLI paths written as `.planning/...` and config loading resolve here. */
  readonly projectRoot: string;
  /** Canonical (realpath) location of `.planning`. Differs from `projectRoot/.planning` when `.planning` is a symlink. */
  readonly planningRoot: string;
  /** Top level of the checkout the process runs in (`git rev-parse --show-toplevel`). In a linked worktree this is the worktree. */
  readonly worktreeRoot: string;
  /** Top level of the main checkout (§2.7). Equals worktreeRoot outside a linked worktree. */
  readonly repoRoot: string;
  /** Absolute `git rev-parse --git-common-dir`; null outside a git repository. */
  readonly gitCommonDir: string | null;
  /** Invariant: isLinkedWorktree ⇔ worktreeRoot !== repoRoot. Stored for callers, asserted by Phase 1's property test. */
  readonly isLinkedWorktree: boolean;
  readonly provenance: ProjectContextProvenance;
}

interface ProjectContextProvenance {
  readonly source: 'explicit' | 'ancestor' | 'workspace' | 'main-checkout' | 'none';
  readonly reason: string;      // e.g. 'ok', 'not_git_repo', 'git_timed_out', 'bare_main_worktree'
  readonly degraded: boolean;   // a git query timed out or could not be spawned
  readonly warnings: string[];
}
```

The epic proposed six fields: `{ repoRoot, worktreeRoot, planningRoot, gitCommonDir, isLinkedWorktree, provenance }`. This ADR adds a seventh, **`projectRoot`**, because "where the `.planning` entry is" and "where its content really lives" are different answers under the `gsd-planning-out-of-repo.md` layout, and real consumers need each. `uat.render-checkpoint`'s containment needs `planningRoot`. A `--file .planning/phases/...` argument and the workspace in a `sub_repos` layout need `projectRoot`. With only six fields, one of them would be derived outside the seam.

`provenance` follows ADR-1411 rule 2: callers branch on it, never on path contents. Its `source` values are:

| `source` | Meaning |
|---|---|
| `explicit` | from `--project-dir` |
| `ancestor` | walk-up from the start directory |
| `workspace` | an enclosing `planning.sub_repos` claims the worktree |
| `main-checkout` | a linked worktree with no reachable `.planning` (§2.4) |
| `none` | nothing found; `projectRoot` is the start directory and `planningRoot` its would-be `.planning` |

Every git subprocess is bounded by the Worktree Safety Policy Module's `DEFAULT_GIT_TIMEOUT_MS` (10 s, `src/worktree-safety.cts:20`) and never throws. On a timeout the resolver degrades to the lexical answer and sets `degraded`.

### 2. Resolution rules

1. **Linked-worktree subdirectory** (#4885). `worktreeRoot` comes from `--show-toplevel`, which returns the linked worktree from any depth inside it, never `dirname(git-common-dir)`. The main checkout is reachable only as `repoRoot`.
2. **Planning store symlinked into its own git repository** (#4815, the `gsd-planning-out-of-repo.md` layout). `projectRoot` is the directory holding the link, and `planningRoot` is the link's realpath target. The walk-up treats a symlink *named* `.planning` as a deliberate hop rather than a nested-repo boundary; this is the #4819 rule, absorbed into the seam. #2843's boundary rule is otherwise unchanged.
3. **Workspaces.** The ancestor walk starts from the start directory itself, with no remap to the main checkout beforehand. A `planning.sub_repos` workspace that encloses the linked worktree is therefore found by the existing sub-repos heuristic. In that case:
   - `projectRoot` is the workspace directory
   - `planningRoot` is the workspace's `.planning`, canonicalized
   - `source` is `workspace`
   - `worktreeRoot` is the linked worktree
4. **Linked worktree with no reachable `.planning`.** This is the case `resolveMainWorktreeCwd` existed for: an agent worktree whose `.planning` is untracked and lives only in the main checkout. The walk finds nothing inside `worktreeRoot`, so the resolver repeats it from `repoRoot`:
   - `projectRoot` and `planningRoot` point into the main checkout
   - `source` is `main-checkout`
   - `worktreeRoot` stays the worktree

   Planning *writes* still land in the main checkout. Code operations and git operations do not.
5. **`--project-dir`** (#4894). The explicit directory **replaces the start directory for every rule above**. So `worktreeRoot`, `repoRoot` and the planning roots are all resolved from it, and `source` is `explicit`. The value lives in the context, not in a global. A path that cannot honor it refuses with a typed reason rather than ignoring it.
6. **Not a git repository.** `worktreeRoot` and `repoRoot` are the lexical start directory, `gitCommonDir` is `null`, `isLinkedWorktree` is false, and `reason` is `not_git_repo`. The planning walk-up still runs. A committing verb refuses.
7. **`repoRoot`** is the first entry of `git worktree list --porcelain` that is not marked `bare`. If every entry is bare, `repoRoot` equals `worktreeRoot` and `reason` is `bare_main_worktree`, and the §2.4 retry is skipped. Inside a submodule, `worktree list` reports the submodule's own checkouts, so `repoRoot` is never the superproject.

### 3. Callers name the root they mean

There is no field called `root` or `cwd`. Each consumer picks one of these:

| Intent | Field |
|---|---|
| run git, run a verify command, resolve a code path, commit | `worktreeRoot` |
| join a `.planning/...` path given relative to the project, load config | `projectRoot` |
| check containment of a planning artifact (`requireSafePath` on `.planning` content) | `planningRoot` |
| shared history: base branch, `worktree list` / prune / inventory, the main checkout's install | `repoRoot` / `gitCommonDir` |

A caller that legitimately needs the main checkout from inside a worktree asks for `repoRoot` by name. That is the epic's anticipated special case, and it is the only way to reach the main checkout.

**Committing verbs** commit in `worktreeRoot`. A path to commit that resolves outside `worktreeRoot` makes the verb refuse with `reason: outside_worktree` and `committed: false`. It is never redirected to another repository.

Under §2.4 this is a **visible behavior change**. Today, a planning commit made from an executor worktree lands in the main checkout and reports `committed: true`. After Phase 1 it refuses. A workflow that intends that commit passes the main checkout explicitly (`--project-dir`), which by §2.5 makes the main checkout the start directory. Phase 1 makes this change with:

- a census of every workflow that commits planning files from a worktree
- the matching workflow updates
- a `Changed` changeset

### 4. Containment for execution targets (#4767)

#4785 already shipped three things:

- an absolute verify-command target outside the root reports `outside_root` (`src/verify-command-grounding.cts:746-755`)
- quick mode runs the probe
- the executor's guard covers `<automated>` execution

The lexical predicate (`tryWithinRootLexical`) is used deliberately, because existence is not evidence for a target that may not exist yet. That stays.

What remains is the **base** the target is compared against. The probe compares against the resolved project root. Under §2.4 that is the main checkout, so in exactly #4767's scenario an orchestrator-absolute path inside the main checkout still counts as "inside". Execution targets compare against `ctx.worktreeRoot`.

This is a warning, never a blocker. A false blocker is "worse than the bug this feature fixes" (#3678).

### 5. Tool resolution is part of the context (#4834)

`gsd_run` resolves candidates in this order:

1. `RUNTIME_DIR` when set
2. the install under `worktreeRoot`
3. the install under `repoRoot`
4. the runtime config homes
5. `PATH`, last and identity-checked

Steps 1, 2, 4 and 5 exist today (#4902). Step 3 is new. Inside a linked worktree with no `gsd-core/` of its own, the snippet skips the main checkout's local install and falls through to a global copy, which is the #4834 shadowing class. The main checkout's install belongs to this project, while a config-home install is global, so `repoRoot` ranks above the config homes.

The order is defined here. The snippet is its only shell encoding: it resolves `worktreeRoot` with `--show-toplevel` and `repoRoot` from `--git-common-dir`, because it runs before `gsd_run` exists. A parity test runs the snippet and `resolveProjectContext` against the same fixture layouts and fails if they disagree.

### 6. The ratchet

The first two decisions undo themselves quietly unless they are enforced by construction:

- **Typed context.** Migrated verbs take `ctx: ProjectContext`, not `cwd: string`. A hand-resolved string root does not typecheck.
- **Lint.** An ESLint rule rejects every resolver below everywhere except `src/project-context.cts`:
  - calls to `findProjectRoot`, `resolveProjectRoot`, `setExplicitProjectRoot`, `resolveWorktreeLinkage`, `resolveWorktreeContext` or `resolveWorktreeRoot`
  - `rev-parse` argv containing `--show-toplevel` or `--git-common-dir`

  It covers `src/`, `bin/`, `gsd-core/bin/` and `hooks/`. Phase 1 deletes those functions or makes them unexported internals of the seam. A companion check over shipped workflow shell rejects raw `git rev-parse --show-toplevel` root resolution outside the launcher snippet. Workflows get roots from `gsd_run query project-context`, a new verb added in Phase 1 precisely so that shell has a sanctioned source. #1414's grep guard is folded into the rule.
- **Positive controls.** Every verb that takes a context is run from a subdirectory of a linked worktree and must act in that worktree or refuse. A parity test fails when a verb is added without a control.

### 7. What "failing-first" means here

Every absorbed bug is already point-fixed on `next`, so a reproducer cannot fail on the base branch. Each phase's regression evidence is therefore two-sided:

- **(a) The contract tests fail first.** They are written against `resolveProjectContext` and the typed consumers before either exists, so they fail as RED.
- **(b) Each issue's reproducer still binds.** It is shown failing with that issue's point fix reverted on a throwaway commit, then passing on the seam with the point fix's logic absorbed or deleted.

## Phase map

Each "Done when" item of #4908 is claimed by exactly one phase. "Failing-first regression per absorbed issue" is split into one row per issue, and each of those rows is claimed by exactly one phase.

| #4908 "Done when" item | Phase |
|---|---|
| One resolver; `findProjectRoot`, `resolveMainWorktreeCwd`, `resolveWorktreeLinkage` consumers or deleted | 1 — [#6043](https://github.com/open-gsd/gsd-core/issues/6043) |
| A committing verb from any depth inside a linked worktree commits there or refuses | 1 |
| A `.planning` symlink into an external git store resolves correctly | 1 |
| Regression #4885 · #4815 | 1 |
| Every git invocation and filesystem write takes its `cwd` from a named context field | 2 — [#6044](https://github.com/open-gsd/gsd-core/issues/6044) |
| `--project-dir` honored uniformly by every path, or refused loudly | 2 (Phase 1 moves it into the context, Phase 2's migration makes it uniform) |
| Regression #4894 · #4799 · #4881 (wrong-root, in verbs Phase 2 migrates) | 2 |
| A `cd` target outside the resolved worktree root warns, absolute or relative; probe runs in quick mode | 3 — [#6045](https://github.com/open-gsd/gsd-core/issues/6045) |
| Regression #4767 | 3 |
| `gsd_run` resolves install-local before `PATH` | 4 — [#6046](https://github.com/open-gsd/gsd-core/issues/6046) |
| Regression #4834 | 4 |
| Lint rejects raw root resolution across `src/`, `bin/`, `hooks/` and workflow shell | 5 — [#6047](https://github.com/open-gsd/gsd-core/issues/6047) |
| Every `cwd`-taking verb has a positive control from a linked-worktree subdirectory | 5 (Phase 1 builds the harness; Phase 5 claims completeness) |

The phases are stacked in order 0 → 1 → 2 → 3 → 4 → 5. Phases 3 and 4 depend only on Phase 1, and Phase 5 depends on all of them. The epic stays open until Phase 5 merges, and Phase 5 ratifies this ADR.

## Consequences

### Bug classes avoided

- **Wrong-repository writes.** No call site can ask for "the root" and get the main checkout. The main checkout must be requested by name.
- **Verification against the wrong tree.** Execution targets are compared against the worktree, not the planning holder.
- **Layout-specific misresolution.** Symlinked stores, workspaces, `--project-dir`, non-git directories, bare repos and submodules are rules inside one resolver, each with a regression test, instead of patches at the site that happened to be reported.
- **Resolver drift.** A further resolver fails lint wherever it is written.

### Cost

- **Process start.** Today a `cwd` that already holds `.planning` spawns no git process before the verb runs. The resolver spawns up to three per process: `--show-toplevel`, `--git-common-dir` and `worktree list`. Each is bounded at 10 s and degradable, and they run once, not per verb call.
- **Migration.** A wide but mechanical migration (Phase 2) changes most verbs' signatures.

### Tradeoff

§3's refusal changes how executor worktrees commit planning files. The workflows that do so are updated in Phase 1, under the epic's contract: commit there or refuse, never elsewhere.

## Alternatives considered

- **Keep fixing at the reported site.** Done seven times. The defect reappeared in resolvers the previous guard could not see. Rejected by the epic's own non-goals.
- **Keep the epic's six fields.** `planningRoot` would have to mean either "holds the `.planning` entry" or "where `.planning` really lives", and either choice leaves one reported consumer deriving the other outside the seam. Rejected; `projectRoot` was added (owner decision, 2026-11-08).
- **Commit planning files wherever they are tracked.** This is less disruptive for executor worktrees, but "never elsewhere" would then hold only for code. Rejected (owner decision, 2026-11-08).
- **Make `findProjectRoot` worktree-aware in place.** It would still return a bare string, so callers would keep choosing a root implicitly and nothing would typecheck the choice. Rejected.
- **Switch execution containment to the realpath predicate.** A target that does not exist yet would then resolve differently than one that does. #4785 chose the lexical predicate deliberately. Rejected.
- **Blocker severity for an outside `cd` target.** Rejected by #3678 and by the epic's non-goals.
- **Let the git-boundary rule permit crossing into symlinked stores in general.** That would reopen #2843 through another trigger. Only a symlink named `.planning` is a hop.

## References

- Epic [#4908](https://github.com/open-gsd/gsd-core/issues/4908) and its comments (2026-09-27, 2026-11-02)
- [ADR-1411](1411-resolution-provenance.md) — resolution provenance
- [ADR-5057](5057-one-owner-per-workflow-verdict.md) — Arm B (verification), which subsumed #4907
- #1414 (walk-up unification), #2843 (git-boundary rule), #4636 (containment predicates), #3678 (no false blockers)
- Point fixes: #5653 (#4885), #4785 (#4767), #4819 (#4815, #4894), #4902 (#4834), #5445 (#4799), #4921 (#4881)
