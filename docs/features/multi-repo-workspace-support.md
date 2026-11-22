---
id: 47
title: Multi-Repo Workspace Support
group: v1.27 Features
---

**Purpose:** Auto-detection and project root resolution for monorepos and multi-repo setups. Supports workspaces where `.planning/` may need to resolve across repository boundaries.

**Requirements:**
- REQ-MULTIREPO-01: System MUST auto-detect multi-repo workspace configuration
- REQ-MULTIREPO-02: System MUST resolve project root across repository boundaries
- REQ-MULTIREPO-03: Executor MUST record per-repo commit hashes in multi-repo mode

**Root resolution:** One resolver, `resolveProjectContext`, answers every "which directory is the project" question. It finds the `.planning` store by walking up from the start directory (or from `--project-dir`), applies the `planning.sub_repos` workspace layout when the checkout sits inside a workspace, and, for a linked git worktree that has no `.planning` of its own, falls back to the main checkout's. It also reports the git facts behind that answer (worktree top level, main checkout, common git dir) and a provenance record, printed by `gsd-tools query project-context`. Inside a linked worktree of a `planning.sub_repos` workspace, GSD resolves the workspace's `.planning` rather than the repository's main checkout. `gsd-tools commit` commits only in the checkout it runs in: it refuses with `outside_worktree` when the working directory, a declared path, or the planning project it would write to lies outside that checkout, and with `not_git_repo` outside a git repository. See [Resolve the project root in a worktree](how-to/resolve-the-project-root-in-a-worktree.md).
