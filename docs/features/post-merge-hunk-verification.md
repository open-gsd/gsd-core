---
id: 103
title: Post-Merge Hunk Verification
group: v1.34.0 Features
---

**Command:** `/gsd-update --reapply`

**Purpose:** After applying local patches post-update, verify that all hunks were actually applied by comparing the expected patch content against the live filesystem. Surface any dropped or partial hunks immediately rather than silently accepting incomplete merges.

**Requirements:**
- REQ-PATCH-VERIFY-01: Reapply-patches MUST verify each hunk was applied after the merge
- REQ-PATCH-VERIFY-02: Dropped or partial hunks MUST be reported to the user with file and line context
- REQ-PATCH-VERIFY-03: Verification MUST run after all patches are applied, not per-patch
- REQ-PATCH-VERIFY-04: `/gsd-update --reapply --interactive[=exceptions|all]` MUST show each user edit with its stock text, the user's text, and a recommended disposition (`keep`, `retire`, or `review`), and MUST wait for a per-edit decision. Bare `--interactive` means `exceptions`. Any other value is rejected (#4435)
- REQ-PATCH-VERIFY-05: `exceptions` mode MUST show only edits flagged `already_upstream`, `partially_upstream`, `region_changed_upstream`, `anchor_orphaned`, `baseline_unconfirmed`, or `diff_too_large`, and MUST keep the rest, printing one summary line for each (#4435)
- REQ-PATCH-VERIFY-06: An edit MUST be retired only by a recorded user decision tied to the edit's content hash. The post-merge gate MUST reject a decision whose edit no longer matches, and MUST list every retired or rewritten edit in its output (#4435)

**Why present-and-gate:** a merge that applies without conflict is not always correct. Upstream can adopt an edit in different words, rewrite the lines around it, or delete the section it was attached to. A wrong automatic retirement deletes the user's work silently, so the tool detects these cases and recommends, and the user decides. See [Review reapplied patches hunk by hunk](../how-to/review-reapplied-patches.md).
