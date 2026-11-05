# ADR-5812: Residue-removal guard standard for `worktree.reap-orphans` [Proposed]

- **Status:** Proposed. This becomes Accepted once [#5233](https://github.com/open-gsd/gsd-core/pull/5233) merges with every decision below mapped to code.
- **Date:** 2026-10-31
- **Issue:** [#5812](https://github.com/open-gsd/gsd-core/issues/5812), a sub-issue of [#4941](https://github.com/open-gsd/gsd-core/issues/4941). The maintainer set this ADR as a prerequisite for #5233 (comment 6485710283) and approved it with a ruling on item 4 (comment on #5812, 2026-10-31).
- **Relationship to prior work:** [ADR-0004](0004-worktree-workstream-seam-module.md) makes the Planning Workspace Module the seam for worktree and workstream state, with a Worktree Root Resolution Adapter; worktree lifecycle safety policy lives in `src/worktree-safety.cts` (the Worktree Safety Policy Module in `CONTEXT.md`). Neither says when that module may delete a directory git no longer tracks. This ADR fills that gap and changes neither. It does not touch [ADR-4630](4630-dispatch-identity-and-isolation-decision-seam.md), which covers isolation decisions, not teardown.
- **Scope:** only the unregistered-residue path (`findUnregisteredResidue`). Reaping registered worktrees in `.git/worktrees/` (dead owner, merged branch, stale lock) predates #5233 and is not covered here.

## Context

Claude Code creates subagent worktrees under `.claude/worktrees/agent-a<hex>`, on a branch named `agent-<id>` or `worktree-agent-<id>`. When its teardown stops partway, a directory can be left behind with no `.git` entry and no registration in `git worktree list`. `worktree.reap-orphans` read only `.git/worktrees/`, so it never saw these directories and reported `reaped: 0` (#4941).

#5233 adds a second discovery source, `findUnregisteredResidue`. Deleting a directory that git does not track cannot be undone, and the guards in #5233 were settled one review at a time. Review 5691418415 then found that the sweep's own `git worktree prune` defeated one of them: a registration had been treated as protection, and any prune ends a registration. This ADR states the whole standard in one place, so the code can be checked against it.

## Decision

The sweep deletes a directory under `.claude/worktrees` only on positive evidence that it is this repository's harness teardown residue **and** holds nothing that cannot be recovered. A directory that fails any check, or that git or the filesystem cannot answer for, is kept. Each decision names the code that holds it in `src/worktree-safety.cts`.

### 1. Positive evidence: every item is required

- **Location.** The candidate is a direct child of `.claude/worktrees`, under the main checkout's canonical top. `.claude` and `.claude/worktrees` must be real directories, not links, whether or not a link resolves (otherwise `residue_dir: aliased`). Run from a linked worktree, the sweep does not look (`not_main_checkout`). If git's directory does not lead back to this top (a `core.worktree`), it does not look either (`git_mismatch`).
- **Shape.** The candidate is a real, non-empty directory with no `.git` entry.
- **Unregistered.** The candidate is absent from `git worktree list --porcelain -z`, read **before** the sweep's own prune. A `prunable` entry counts as registered.
- **Harness identity.** The name matches `HARNESS_WORKTREE_NAME_RE` (`^agent-a[0-9a-f]{7,}$`) and a harness branch exists, `agent-<id>` or `worktree-agent-<id>` (`residue_not_harness_named`, `residue_no_harness_branch`).
- **Reserved-name exception.** A child named `.gsd-reap-<16 hex>` (`STRANDED_REAP_NAME_RE`) is taken to be one this sweep stranded partway through a removal (decision 5). The name is not proof: the name is reserved for the sweep, and a directory carrying it is trusted by that contract. It needs neither the harness name nor a branch, and it skips decision 2, which it passed in the sweep that renamed it. Every other check still applies to it, decision 4 included. It stays in place until `REAP_MTIME_GUARD_MS` after its ctime, since until then it may be another sweep's removal in progress.

### 2. No work git lacks: the guard that protects work

The directory must match the tip of one harness branch, compared in a throwaway index (`GIT_INDEX_FILE` in a temporary directory) so neither the checkout's index nor the directory is touched. To match, it must hold:

- no modified, deleted, or untracked-and-unignored file;
- no untracked `.gitignore`, at any depth: one holding `*` would hide everything, itself included;
- no content at a submodule (gitlink) path, which git does not look into without the submodule's `.git`.

This is the standard `git worktree remove` applies without `--force` (`residueHoldsWork`, `residue_has_work`). A registration is **not** what protects work. Any `git worktree prune` ends one: the sweep's own prune, `/gsd-progress`, wave cleanup, execute-phase step 5.5, or `git gc` (review 5691418415, Blocker 1). If git cannot compare against any branch, the directory is kept as `residue_unverified`.

### 3. Disqualifiers: any one keeps the directory, with a row

| Disqualifier | Reason |
|---|---|
| Git tracks a file under it, checked in the checkout's own index with a literal, case-insensitive pathspec (`:(icase,literal)`), so a case-only rename cannot hide a tracked file | `residue_tracked` |
| A repository lies inside it at any depth (a `.git` entry or a bare `HEAD` + `objects/` + `refs/` layout, case-folded), including inside `node_modules`. Found by a walk that never follows links, bounded at `RESIDUE_WALK_LIMIT` entries | `residue_contains_repository`; past the bound, `residue_unverified` |
| It, or any entry inside it, is younger than `REAP_MTIME_GUARD_MS` (it may still be in use) | left without a row; `residue_age_unknown` when an age cannot be read |
| It holds the sweep's root or the process's working directory | `residue_contains_cwd` |
| Git or the filesystem cannot answer a check | `residue_unverified`, `residue_unreadable` |
| It holds an ignored secret or user-data file the harness did not create (decision 4) | `residue_has_user_data` |

### 4. Ignored files: disposable, except secrets and user data the harness did not create

**Maintainer ruling on #5812.** Matching a harness branch tip, with ignored files treated as disposable, is not enough on its own. If a candidate holds an ignored file that the harness did not create and that matches a secret or user-data pattern, the directory is **kept**, with a skip row. Losing such a file cannot be undone, and git does not track it. All other ignored files stay disposable, matching `git worktree remove` without `--force`.

How the code applies the ruling (`residueHoldsUserData`, `RESIDUE_USER_DATA_PATHSPECS`, `isHarnessCopy`):

- **Every candidate.** The check runs for every candidate, a reserved-name one included, and does not depend on which harness branch matched in decision 2.
- **Secret or user-data pattern.** The pattern set is:
  - `.env*` and `.secrets`, and any file inside a directory with one of those names, at any depth, case-insensitive. This is broader than the secret read guard (`hooks/gsd-secret-read-guard.js`), which exempts `.env.example` and similar. Here an ignored `.env.example` also keeps the directory, which costs at most a skipped row.
  - Any file under `.planning/`. GSD's own planning files are ignored when `planning.commit_docs` is `false`, and an executor in a worktree writes there.

  The files are listed with `git ls-files --others --ignored --exclude-standard` against an empty throwaway index, so every ignored match is seen, including files inside a wholly ignored directory such as `node_modules/`, and a file some branch force-added.
- **Did not create.** Claude Code copies the ignored files that `.worktreeinclude` names from the main checkout into each worktree it creates. A file is a harness copy only when a regular file with the same bytes, at most 1 MiB, sits at the same path in the main checkout **and resolves outside the candidate**. A main-checkout path that leads into the candidate through a link is the file being removed, not a copy. A true copy still exists after removal, so nothing is lost. Anything else is not a copy and keeps the directory: a file absent from the main checkout, one that differs, one that is not a regular file, or one that cannot be read.

### 5. Removal protocol

1. Right before removing, check again that `.claude` and `.claude/worktrees` are real directories, that the candidate is still a real directory with no `.git` entry, and that its resolved path is still directly inside `.claude/worktrees`. If any of these fails, keep it as `residue_unreadable`.
2. Rename the candidate to an unguessable `.gsd-reap-<16 hex>` name inside that directory. If the rename fails, the candidate is kept as `residue_remove_failed`. There is one exception: the candidate is gone and the parent is the same directory, by device and inode. Then a concurrent sweep took it and reports it, so this sweep reports no row. A parent that was moved, even one recreated in place, gets the failure row.
3. Check that the renamed directory landed where expected, as a real directory. If it did not, rename it back and report `residue_unreadable`.
4. Remove it with `fs.rmSync` recursive, which unlinks a nested symlink or junction rather than following it. If the removal throws partway, rename what is left back and report `residue_remove_incomplete`, since part of it may already be gone.

Whenever a rename back fails, the row names the reserved path instead, because that is where the files are.

### 6. Reporting contract

- `scan` names which sources were read, so `reaped: 0` never means "did not look". `admin_dir` is `scanned`, `absent`, `unreadable`, `git_dir_unresolved` or `default_branch_unresolved`. `residue_dir` is `scanned`, `absent`, `unreadable`, `aliased`, `not_main_checkout`, `top_unresolved`, `git_mismatch` or `not_scanned`. `scan` is `null` when the sweep threw.
- A kept candidate is a `skipped` row with one of the reasons above. When `git worktree list` itself fails, every candidate is kept as `worktree_list_failed`. A removed one is `reaped` / `unregistered_residue`, and its `contents` field names what it held at the top level. The checks prove a directory is harness residue, not that nothing in it was wanted.
- On stderr:
  - removed directories and what each held, escaped by `formatDiagnosticToken`, cut to 64 code points, at most five names each;
  - kept directories, counted by reason, not named;
  - a removal that stopped partway;
  - a location that was not swept.
- This ADR does not change what workflow callers do with stdout or stderr; that is out of scope.

### 7. Accepted limits

- **Walk-to-rename window.** A file written between the walk and the rename is removed with the directory. The age guard on every entry makes this need a writer that is active at exactly that moment.
- **Repository created mid-walk.** A repository created inside the candidate after the walk passed its location is not seen (review finding 8). It is subject to the same window.
- **Case spellings of `.claude`.** On a case-insensitive filesystem, `.claude` and `.Claude` are one directory. The sweep does not reason about spellings. Its one case-sensitive risk, a tracked file listed under another spelling, is covered by the case-insensitive pathspec in decision 3, which keeps the directory.
- **The user-data pattern set is a list, not a classifier.** An ignored secret under some other name (for example `config/credentials.json`) is disposable, as it is to `git worktree remove`. The set is extended by adding a pathspec to `RESIDUE_USER_DATA_PATHSPECS`, with a test row.

## Alternatives considered

- **Report only, never delete.** This is the safest option, but it leaves #4941 unfixed: residue keeps growing and the operator has to delete it by hand, with no guard at all.
- **An opt-in removal verb.** This moves the decision to a person without giving them better evidence than the sweep has. The guards would still be needed, so the verb adds a surface and no safety.
- **A journal instead of a reserved name.** Recording in-progress removals in a file adds a second piece of state that can go stale, and that a crash can leave inconsistent with the disk. The reserved `.gsd-reap-*` name is recorded by the rename itself, atomically.
- **Treat registration as protection (an earlier #5233 revision).** Rejected by review 5691418415: any prune ends a registration.

## Consequences

- #5233 cites this ADR. Every guard it implements maps to a decision above, and every decision maps to code or is named in decision 7. The `CONTEXT.md` pointer lands with #5233, which already rewrites the Worktree Safety Policy Module entry. Adding it here would conflict with that edit.
- A new removal guard, or a relaxed one, is an amendment to this ADR, not a code-only change.
- #4941 stays open until #5233 merges.
