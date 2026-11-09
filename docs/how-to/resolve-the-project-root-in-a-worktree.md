# How to resolve the project root in a worktree

**Goal:** Find out which checkout GSD acts in from a linked worktree, read how it decided, and fix a `commit` that is refused with `outside_worktree` or `not_git_repo`.

**Prerequisites:** `gsd-tools` is installed and you are in the directory you ran the command from.

---

## See which checkout GSD acts in

Print the resolved context:

```bash
gsd-tools query project-context
```

Read these fields first:

- `worktreeRoot` is the checkout your shell is in.
- `projectRoot` is the directory that owns `.planning/`.
- `repoRoot` is the main checkout; `isLinkedWorktree` is `true` when it differs from `worktreeRoot`.

For the worktree top level alone, add `--raw`.

## Read the provenance

`provenance.source` says which rule found `projectRoot`:

| `source` | Meaning |
|----------|---------|
| `explicit` | You passed `--project-dir` |
| `ancestor` | A `.planning` was found in the start directory or a parent |
| `workspace` | The enclosing `planning.sub_repos` workspace owns it |
| `main-checkout` | The worktree has no `.planning`, so the main checkout's is used |
| `none` | No `.planning` found; `projectRoot` is the start directory |

`provenance.reason` says what git reported. `ok` is normal. `git_timed_out`, `git_unavailable`, `git_error`, and `worktree_list_failed` set `degraded: true` and add a `warnings` entry; GSD falls back to the start directory and does not refuse commits on a degraded context. `not_git_repo` means git reports no repository there.

## Fix an `outside_worktree` refusal

`gsd-tools commit` writes only inside the checkout it runs in. It exits non-zero with `committed: false` and `reason: "outside_worktree"` when the working directory, a `--files` path, or the planning project it would write to is outside that checkout. The message names the offending path.

This happens when the worktree has no `.planning/` of its own and `source` is `main-checkout`, or when the worktree lives inside a `planning.sub_repos` workspace whose `.planning/` is outside the worktree.

1. Run `gsd-tools query project-context` and note `projectRoot`.
2. Re-run the commit against the checkout that owns the path:

```bash
gsd-tools commit "docs: update state" --files .planning/STATE.md --project-dir <main checkout>
```

Pass the main checkout (or the workspace's own repository) to `--project-dir` so the commit lands in that repository, not the worktree.

## Fix a `not_git_repo` refusal

The refusal means git reports that the directory is not inside a repository. Run the commit from inside the repository, or pass `--project-dir` pointing at one. Confirm with `gsd-tools query project-context`: `provenance.reason` stays `not_git_repo` until the directory is inside a repository.

## See also

- [`gsd-tools query project-context` reference](../COMMANDS.md#gsd-tools-query-project-context)
- [Multi-Repo Workspace Support](../FEATURES.md#47-multi-repo-workspace-support)
