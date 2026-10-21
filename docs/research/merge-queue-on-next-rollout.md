# Merge queue on `next` — rollout plan

**Date:** 2026-10-21
**Status:** Draft design. Nothing here is applied: no ruleset, setting, workflow or label was changed.
**Follows:** [time-boxed-bugfix-train.md](time-boxed-bugfix-train.md), "Maintainer decisions (2026-10-21)". The maintainer chose Option B (a GitHub merge queue on `next`) for the first attempt. The train (Option C) is deferred.

Source labels: **[M]** measured in this repo, **[D]** GitHub docs (fetched 2026-10-21), **[R]** recommendation. **UNVERIFIED** marks anything I could not confirm from a primary source.

---

## 1. TL;DR

1. **Merge method: `SQUASH`.** The train memo rejected squash because it would squash a whole train into one commit. With a queue on `next` there is no train: each queued PR becomes one commit, which is already the repo convention (`docs/branching.md`: "Squash-merge means each PR becomes one commit on `next`") and what `release.yml`'s one-`fix:`-commit-per-fix hotfix pick expects. `REBASE` would land every fix PR as its full commit list (7.0 commits on average [M, train memo §2.2]). `MERGE` breaks the convention.
2. **The queue removes the rebase treadmill.** The queue builds each PR on top of the base and the PRs ahead of it, so authors no longer update their branch or wait for checks again [D: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue]. That targets the measured pain: 119 of 139 merged `fix/` PRs saw a landing on `next` while open, 41% were force-pushed, 62 of 79 open PRs are `BEHIND` [M].
3. **One blocker must be solved first: the main-to-next back-merge.** `auto-backmerge.yml` builds a `-s ours` merge commit and merges it so `main` becomes an ancestor of `next`. A squash queue would flatten that commit and break the invariant. See §4. This is also the area where #4999 went wrong and was reverted in full (#5001, "scope expansion beyond the request"), so the plan stays small.
4. **Roll out in four phases**, `evaluate` mode first, one scoped change per PR, no bot and no new secrets before Phase 3.
5. **Approval policy (decided):** per-fix review stays. A maintainer's PR needs no review, so no `--admin` merge. A non-maintainer's PR must be reviewed. `trek-e` is the only maintainer while testing.

---

## 2. What the queue does here (primary sources)

| Fact | Source |
|---|---|
| The queue offers merge, rebase or squash; the setting is "Select which method to use when merging queued pull requests". | [D] managing-a-merge-queue |
| A required check must report on `merge_group`; for Actions the workflow needs the `merge_group` event or the check is never reported and the merge fails. | [D] same page |
| On a failing check or a conflict the PR is removed from the queue and the rest are rebuilt without it. Timeout and a user request also remove a PR. | [D] same page |
| Settings: build concurrency (1 to 100), min and max PRs per merge, a wait time for the minimum, "Only merge non-failing pull requests", and a status-check timeout. The page states no defaults. | [D] same page |
| The queue gives the benefit of "require branches to be up to date" without authors updating branches. | [D] same page |
| Whether admins or bypass actors can skip the queue: **UNVERIFIED**. The page does not say. Test in `evaluate` mode before relying on it. | [D] same page, silent |

---

## 3. Merge-method decision

| Method | Result on `next` | Verdict |
|---|---|---|
| **SQUASH** | one commit per PR; PR title becomes the message (`Default to "Pull request title"` is already ON per `docs/branching.md`) | **Recommended.** Matches current practice. Compatible with `required_linear_history` and `allowed_merge_methods: ["squash","rebase"]` in `main-protection.json`. |
| REBASE | every commit of every PR lands | Rejected. 7.0 commits per fix PR on average [M]. `docs/branching.md` says rebase merging should be OFF; the live repo has it ON [M]. |
| MERGE | a merge commit per PR | Rejected. Breaks the squash convention and linear history. |

Consequence to accept: the queue's one method applies to **every** PR into `next`, features and docs included [D, one setting per queue]. That is fine because the repo already squashes everything. The only exception is the back-merge (§4).

---

## 4. The blocker: main → next back-merge

Facts [M, `.github/workflows/auto-backmerge.yml`]: the workflow creates `chore/backmerge-main-to-next-<sha>`, runs `git merge -s ours --no-commit --no-ff origin/main` so `next` keeps its own tree, and the PR is admin-merged "so `main` becomes an ancestor of `next`", "the invariant that keeps the next `release → main` merge clean". `docs/branching.md` line 47: "release back-merges use merge commits to preserve tag context". A required-steps test (`release-backmerge-invariants.test.cjs`) pins parts of this.

Problem: a queue with `SQUASH` would turn that merge commit into a plain commit with one parent. `main` would not become an ancestor of `next`, and the next release merge would conflict. Under the same ruleset, `required_linear_history` already forbids merge commits; `main-protection` is in `evaluate` mode today [M], so that conflict has never been enforced.

Options:

| Option | How | Cost | Verdict |
|---|---|---|---|
| **A. Ruleset bypass for the back-merge actor only** | Add one bypass actor (the `gsd-bot` app or a dedicated role) with mode `pull_request`, so only that actor can merge outside the queue | Smallest. Relies on bypass applying to the queue rule: **UNVERIFIED** | **Recommended; verify in `evaluate` first.** |
| B. Back-merge via the queue with method `MERGE` | Needs a separate queue per PR type, which GitHub does not offer: one method per queue | not possible | Rejected |
| C. Replace the back-merge with a direct fast-forward-style push | Rework of the release machinery | Large; touches the release flow | Out of scope |
| D. Rebuild #4999's merger workflow | A privileged workflow that merges when green | Exactly what #5001 reverted | Do not |

If A fails the verification, Phase 3 stops and the queue is not enabled. The cost of that outcome is zero: the earlier phases are still useful.

---

## 5. Required wiring (all verified against the repo [M])

| Gap | Fix | Phase |
|---|---|---|
| `test.yml` already has `merge_group:` (#4241), so `Required tests` reports | none | done |
| The six metadata workflows (`check-branch`, `changeset-lint`, `docs-lint`, `validate-target`, `Issue link required`, `Pull request template format`) do not trigger on `merge_group` | add `merge_group:` and make their jobs skip on that event, so a skipped job reports as passing. This is the part of #4999 worth re-doing, **alone**, in its own PR | 1 |
| Rebase merging is ON though docs say OFF | keep ON until Phase 3, then turn OFF so the queue's `SQUASH` is the only path | 3 |
| `merge_group` runs use the scoped matrix unless `full_matrix` is set; `ci-test-scope.cjs` sets `full_matrix=true` only on push | **Decided:** the full matrix (Windows, macOS, install, slow) runs on `merge_group` only; PR runs are Linux-only plus a `full-matrix` label opt-in for risky PRs (installer, hooks, workflows, paths). Changing `ci-test-scope.cjs` and `test.yml` is a separate PR. The group wait adds up to 15 min on top of the run. Median green run is 31.5 min, p90 65.4 min [M] | 2 |
| `gsd-merge-authority-guard.cjs` and `bug-fixer.md` lines 985-1010 assume `gh pr merge` and `--admin` | change step 6 to "add to queue" (§7) | 3 |

---

## 6. Ruleset (draft)

`.github/rulesets/next-queue.json`, started with `"enforcement": "evaluate"`. Parameter names follow the REST docs [D: https://docs.github.com/en/rest/repos/rules]. `main-protection.json` stays; this file adds only the queue and the approval rule.

```json
{
  "name": "next-queue",
  "target": "branch",
  "enforcement": "evaluate",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "check_response_timeout_minutes": "MAINTAINER_DECISION_SEE_NOTE_1",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 2,
        "max_entries_to_merge": 3,
        "merge_method": "SQUASH",
        "min_entries_to_merge": 2,
        "min_entries_to_merge_wait_minutes": 15
      }
    }
  ]
}
```

Notes [R]:
1. `check_response_timeout_minutes` is a required integer and is left as a placeholder on purpose; it is the maintainer's call. Input: the p90 green run is 65.4 min. Replace the string before applying; the file is not valid as written.
2. **Batched queue (decided 2026-10-21).** `max_entries_to_merge: 3`, `min_entries_to_merge: 2`, wait 15 min: the queue holds up to 15 minutes to collect two PRs, never more than three, then runs the full matrix **once** on the group. Per-PR runs are Linux-only and cheap; the expensive Windows and macOS lanes run only on `merge_group` [main memo, decision 2]. Estimated effect: full runs fall from one per PR toward one per 2 to 3 PRs; the numbers are in `main-vs-next-branch-model.md` §4.2 and must be recomputed for batching in Phase 4. Cost: when a group fails, GitHub removes the failing PR and rebuilds the rest [D], so a bad PR costs the group one extra full run, and attribution needs the failing job log. `ALLGREEN` keeps a PR whose own required checks failed out of a group. Raise or lower the size from Phase 4 data. The Rust project batches low-risk PRs for the same reason [X: https://forge.rust-lang.org/release/rollups.html]. How `min_entries_to_merge_wait_minutes` interacts with `max_entries_to_build: 2` is stated only briefly in the docs: **UNVERIFIED**; observe it in `evaluate`.
3. `ALLGREEN` means a failing PR never joins a group. `HEADGREEN` would let a failing PR through if the last PR in the group passes [D].
4. Keep the existing seven required contexts on `next`. The queue does not replace them; it re-runs them on the merge-group commit.
5. "Require merge queue" is repository-level only, not organization-level [D, available-rules page; carried over from the train memo and not re-fetched here]: **UNVERIFIED** in this pass.

### Approval rule (decision 3)

The pull-request rule already in `main-protection.json` has `required_approving_review_count: 0`. The decided policy is: a non-maintainer's PR must be reviewed; a maintainer's PR needs no review. The ruleset's review count is one number for everyone, so it cannot express "required unless the author is a maintainer".

| Option | Mechanism | Verdict |
|---|---|---|
| **A. Count 1 on `next`, with the maintainer allowed to self-approve the merge** | A required review of 1 is not satisfiable by the author on their own PR | Reproduces the admin merge the policy wants to end. Rejected. |
| **B. Count 0 in the ruleset; a required status check enforces it** | New check `Reviewed or maintainer` (pull_request_target, no checkout of PR code): passes when the author is in the maintainer list, otherwise requires an approving review from a different account with write access | **Recommended.** Matches the stated policy exactly and needs no bypass. The maintainer list lives in a file on `next` (initially `trek-e` only). |
| C. CODEOWNERS with `require_code_owner_review` | Reviews are required from owners; the file must be on the base branch [D] | Does not exempt the owner from needing a second reviewer. Rejected. |

The existing `dismiss-unauthorized-pr-approvals.yml` already exists [M, workflow list]; Option B's check should read the same maintainer source so there is one list. I did not read that file's contents in this pass: **check before building**.

---

## 7. Self-test report, scoped for the queue

Without a train there is no cutoff, so the report moves from "required before admission" to "required before queue entry". Trust model unchanged: CI on the merge-group commit is authoritative; the report is a triage signal and a gate on effort [train memo §6.4].

- **Where:** the `fix.md` PR template section, as in the train memo §6.2.
- **Bound to the head SHA.** With a queue, authors no longer rebase, so the head SHA stays stable after review. This removes most of the sha-invalidation cost that CONTRIBUTING.md's "rebase last" rule works around.
- **Checks:** `Report present and well-formed` (cheap, format only) and `Failing-first reproduced` (CI runs the named test on base and on head). Both are `pull_request` workflows with no secrets and read-only permissions; the PR is untrusted. Use `pull_request`, not `pull_request_target`, for anything that runs PR code [D: https://docs.github.com/en/actions/reference/security/secure-use].
- **Phase it.** Land the format check in advisory mode first (not a required context), measure how often fork authors fill it in, then decide whether to require it.
- **External contributors:** accept `tool.name` of `gsd-test`, `npm-test` or `manual` and do not treat them as equivalent.

---

## 8. Rollout

| Phase | Change | Enforced? | Exit check |
|---|---|---|---|
| **0. Baseline** | Record the §2.2 numbers of the train memo as the "before". Add the date range and commands to the PR. | no | numbers saved |
| **1. Wiring** | PR: `merge_group` trigger on the six metadata workflows, jobs skipped on that event. Nothing else. | no queue yet | a manual test: create a throwaway branch in a fork or test repo, enable a queue there, confirm all seven contexts report |
| **2. Evaluate** | Add `next-queue.json` in `evaluate`, plus the `Reviewed or maintainer` check in advisory mode and the report format check in advisory mode. Decide the timeout. The matrix split and batch size are decided (§6 note 2). | evaluate only | one week of `rule-suites` hits reviewed (`docs/branch-protection.md`, "Reading evaluate-mode logs"); bypass-on-queue behavior confirmed or refuted for the back-merge actor |
| **3. Enable** | Set enforcement `active`. Turn rebase merging OFF. Make `Reviewed or maintainer` required. Update `bug-fixer.md` step 6 to `gh pr merge` (adds to the queue; auto-merge if checks are pending [D: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue]) and remove the `--admin` path. | yes | back-merge still merges; a deliberately failing PR is ejected without blocking the next |
| **4. Measure** | After 4 weeks compare with Phase 0: landings-while-open for `fix/` PRs, force-push share, BEHIND count, queue wait time, ejections. | — | decision memo: keep, tune batch size, or revisit the train |

**Kill criterion [R]:** disable the ruleset (it is one JSON file) if median queue wait for a green PR exceeds 2 hours for two weeks, or if the back-merge cannot be made to work under Option A.

---

## 9. `bug-fixer.md` changes (queue on `next`)

Far smaller than the train version. Line numbers are from the current `~/.claude/commands/bug-fixer.md`.

| Where | Change |
|---|---|
| Lines 985-1003 (the merge-authority gate block) | Keep the live-state checks (they are the safety net). Drop the `admin` and `admin_reason` allowance once Phase 3 lands: with a queue and `Reviewed or maintainer`, no `--admin` is needed. |
| Line 1004-1010, step 6 "Merge" | Replace with: run `gh pr merge <n>` (adds to the queue, or enables auto-merge while checks run); then **watch the queue**, not the merge. A PR can be ejected: read the timeline reason; a real failure is a normal fix cycle, never a re-run to green. |
| Rebase-last steps (about lines 858-865) | Remove the pre-push rebase for queue-bound PRs. The queue handles the base moving. The `gsd-test` pass marker stays valid because the head SHA no longer changes. |
| Step 7 (issue close) | Unchanged. `Fixes #N` works because the PR targets `next`, the default branch. This is a benefit of B over the train [D: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue]. |

`.claude/hooks/pre-pr-gate.sh` and the `gsd-test-verify` skill keep `origin/next` as the base. No change, another benefit of B.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Re-doing part of #4999 reads as the same scope expansion | Phase 1 is only the `merge_group` trigger, in its own PR, with the maintainer's explicit request linked. No merger workflow, no bot token, no environment plumbing. |
| Queue wait (31.5 min median, 65.4 min p90 per entry) stacks up behind a slow matrix | `max_entries_to_build: 2`; the 15-minute group wait adds to this; measure in Phase 4. |
| A flaky test ejects an unrelated PR | Policy stays: no re-run to green. Ejection becomes a visible, attributable event instead of a silent admin merge. Real flake rate was not measurable [train memo §2.4]. |
| Back-merge breaks | Gated by Phase 2 exit; Phase 3 does not start without a working answer. |
| Fork PRs show `action_required` for approval before CI runs (42 in the 8-day window [M]) | Unchanged by the queue. Approving the workflow run is still a manual step before a PR can enter the queue. |
| The maintainer list in `Reviewed or maintainer` grows stale | One file, one owner, and the same source as `dismiss-unauthorized-pr-approvals.yml`. |

## 11. Open items for the maintainer

1. The `check_response_timeout_minutes` integer (§6 note 1).
2. ~~Matrix scope~~ decided: full matrix on `merge_group` only, batch of up to 3.
3. Who may be on the maintainer list beyond `trek-e` once testing ends.
4. Confirm the bypass actor for the back-merge (§4 Option A): the existing `gsd-bot` app, or a dedicated one.
