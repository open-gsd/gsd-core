---
type: Fixed
pr: 1484
---
**`findProjectRoot` now respects explicit `sub_repos` config over implicit `.git`** — when a parent workspace's `.planning/config.json` lists a child directory in `sub_repos`, that declaration takes precedence over the child's own `.git/` directory. Previously, if the child had both `.planning/` and `.git/`, the `.git` heuristic fired first and resolved to the child rather than the parent workspace, making the `sub_repos` declaration ineffective. (#1422)

**`phases clear` now refuses to delete phase directories with uncommitted changes** — `cmdPhasesClear` runs `git status --porcelain` over the phases directory before executing any deletion. If uncommitted or staged-but-not-committed files are found it aborts with a clear error message, preventing silent data loss at `new-milestone` time. Pass `--force` to bypass the guard when archival is already complete. Non-git projects are unaffected. (#1447, data-loss fix)

<!-- docs-exempt: internal CLI guard in milestone.cts — no public docs surface change; --force flag is an operator escape hatch, not a user-visible API change -->
