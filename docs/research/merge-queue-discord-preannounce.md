# Discord pre-announce — draft

Not posted. Each block is under 2000 characters (the non-Nitro limit). Paste them in order as separate messages. Adjust the channel before sending.

## Block 1

**Heads-up: how fixes will land on `next`**

We're trying a **GitHub merge queue on `next`** to stop the rebase treadmill on bug-fix PRs.

**Why:** in the last 30 days, 119 of 139 merged fix PRs saw `next` move under them while they were open. Most open PRs are currently "behind". Every landing meant another rebase, another CI cycle and another re-test. A few merges also landed without being tested against the current `next`.

**What changes for you**
- You still open your PR against `next` with a linked, confirmed issue.
- **You no longer rebase or "update branch" just because `next` moved.** Once your PR is approved and green, it joins a queue. GitHub groups it with up to two other approved PRs, runs the full cross-platform tests once on the group, then squash-merges each. If it fails there, it's removed and the reason shows on the PR.
- Please don't push new commits after approval unless you need to. A new push means a new review and a new run.

## Block 2

**Self-test report (fix PRs)**
The fix PR template gets a short section: the failing test you wrote, that it fails before your change and passes after, the command you ran, and your OS and Node version. CI re-runs it, so it's a head start for reviewers, not a substitute for CI. Advisory at first.

**Reviews**
PRs from outside the maintainer team need an approving review. Maintainer PRs won't need an admin override to merge.

**What doesn't change:** squash-merge (one commit per PR), changesets, the issue-first flow, and no "re-run until green". A red check is a real finding.

## Block 3

**Timeline**
1. Now: this heads-up, plus a small CI change so every required check reports in the queue.
2. Next: the queue runs in "evaluate" mode, so we can see what it would do without enforcing it.
3. After about a week of clean results: we turn it on. I'll post the date here first.
4. After four weeks: we compare the numbers and keep it, tune it, or try a weekly fix-train branch.

If it makes things worse we'll switch it back. Questions or edge cases (release branches, hotfixes, workflow changes)? Reply here.

---

## Single short message (if you want only one)

Heads-up: we're trying a GitHub merge queue on `next` so you stop rebasing fix PRs every time something else lands. Open PRs as usual; once approved and green they join the queue, are grouped (up to 3), tested once on all platforms, and squash-merge automatically. PR runs themselves get cheaper (Linux only). Fix PRs will also get a short self-test report section (failing test, before/after result, command, OS/Node), advisory at first. CI stays authoritative. Evaluate mode first; I'll announce the switch-on date here.
