---
id: 5019
title: Lane Evidence Persist, Read and Clear
group: v1.7.0 Features
---

**Command:** `gsd_run lane-evidence-persist <review-path> <suffix> <auto|once>` (block on stdin), `gsd_run lane-evidence-read <review-path>`, `gsd_run lane-evidence-clear <review-path> [--keep-auto]`

**Purpose:** `/gsd-code-review` carries the external-reviewer evidence into the `code-review-fix` workflow's `--auto` re-reviews. The evidence is kept under the temp directory, keyed to the review file, so nothing is written into the project or its git metadata; the three verbs are its single owner.

**Behavior:** `code-review` persists the block at dispatch (a dispatch with no evidence persists nothing and removes its lane directory), `code-review-fix` reads it back before each re-review, and both clear it: `code-review` at `check_empty_scope`, in `commit_review` (with `--keep-auto`, which keeps an `--auto` state for the fixer loop), and when the reviewer agent fails; `code-review-fix` at every exit after `REVIEW_PATH` is computed. The state is `<suffix>\n<auto|once>\n<block>`, where only a 6-character alphanumeric suffix names a `$TMPDIR/gsd-review-lanes-<suffix>` (`/tmp` when unset, `os.tmpdir()` on Windows) directory. A symlinked, foreign-owned or malformed state, or a state idle for 6 hours, is never read; a rejected state read prints a warning. The verbs exit 0 when there is nothing to do.

**Reference:** [`lane-evidence-persist`, `lane-evidence-read`, `lane-evidence-clear`](COMMANDS.md#lane-evidence-persist-lane-evidence-read-lane-evidence-clear)
