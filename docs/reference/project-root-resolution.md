# Project-root resolution

> Reference. How the CLIs and isolation hooks resolve the project root in multi-repo workspaces. The
> `sub_repos` setting is in [Configuration](../CONFIGURATION.md#project-root-resolution-in-multi-repo-workspaces).

When `sub_repos` is set and `gsd-tools.cjs` or `gsd-tools query` is invoked from inside a listed child repo, both CLIs walk up to the parent workspace that owns `.planning/` before dispatching handlers. Resolution order (checked at each ancestor up to 10 levels):

1. If the starting directory already has its own `.planning/`, it is the project root (no walk-up).
2. Parent has `.planning/config.json` listing the starting directory's top-level segment in `sub_repos` (or the legacy `planning.sub_repos` shape).
3. Parent has `.planning/config.json` with legacy `multiRepo: true` and the starting directory is inside a git repo.
4. Parent has `.planning/` and an ancestor up to the candidate parent contains `.git` (heuristic fallback).

The walk never reads above `$HOME`. When `$HOME` is a symlink, it stops there whether the path is spelled through the link or through its target. A starting directory at `$HOME` itself, with no `.planning/` of its own, resolves to itself.

The isolation hooks resolve their project root through the same walk, so they keep the same `$HOME` boundary as `gsd-tools`.

If none match, the starting directory is returned unchanged. Explicit `--project-dir /path/to/workspace` is idempotent under this resolution.

The `verification` verbs (`status`, `all-summarized`, `resolve-file`, `fingerprint`, `append-audit`) take the project root from the context the dispatcher resolved once for the process, so an explicit `--project-dir` is their project root too, including for the staleness check behind `phase.complete`. They no longer walk up from the phase directory. This matters when the phase directory is addressed by a path that does not lead back to the project — for example the real path of an externally git-managed `.planning` store.

Planning artifacts passed by path (`uat render-checkpoint --file`, `uat complete-session`, `verification append-audit`, `summary-extract`, `coverage classify`, `loop render-hooks --after-fingerprint`) are checked against the real location of `.planning/`, so a `.planning` symlinked into a separate repository is accepted while a path that leaves both the project and that store is still refused.
