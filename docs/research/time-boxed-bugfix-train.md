# Time-boxed bug-fix train — research and design memo

**Date:** 2026-10-21
**Trigger:** Maintainer request: replace "chasing `next`" for bug fixes with a time-bound integration branch. Everyone submits fixes against it and tests against it. CI sequences and tests. An approval gate admits each fix. The whole train then merges as one unit. Part of the testing is offloaded to the bug submitter.
**Status:** Research and design input. No workflow, ruleset, setting, label or GitHub state was changed. Nothing here is enabled.
**Reading time:** ~25 min. Sections 1, 3 and 9 are enough for a go/no-go.

## Maintainer decisions (2026-10-21)

1. **Option B first.** A GitHub merge queue on `next` is enough for the first attempt. The train (Option C) is deferred, not rejected: revisit it if B leaves the §2 pain in place. Sections 4.1, 4.2 and 6.3's `open-train`/`close-train`, and the §7 `PR_BASE` change, are therefore **not in scope now**.
2. **Defaults accepted.** Cadence and window defaults stay on file for a later train. The queue timeout value is still open (measured p90 green run: 65.4 min).
3. **Approval.** Per-fix review stays. A maintainer's review is **not required**, so no admin merge is needed. A non-maintainer's PR **must** be reviewed. While testing, `trek-e` is the only maintainer.

**Still open under B:** the merge method (§4.6: one method for all of `next`; `SQUASH` per `docs/branching.md` vs `REBASE` at 7.0 commits per fix PR), and the retained scope of the submitter self-test report (§6) against `next` instead of a train.

---

Source labels: **[M]** measured in this repo (command given), **[D]** GitHub docs, **[X]** another project's own docs, **[R]** recommendation. Anything I could not verify is marked **UNVERIFIED**. GitHub docs pages were fetched on 2026-10-21.

---

## 1. TL;DR

1. **Recommendation:** build the train, but as *train + merge queue on the train branch*. A train alone does not stop the chasing. Fixes are 139 of the 230 PRs that landed on `next` in the last 30 days (60%), so a fix-only branch still moves about 4.6 times a day [M §2.2]. The queue is what removes the rebase treadmill: queued PRs are built against the queue, not rebased by hand [D].
2. **Shape:** weekly branch `train/YYYY-wWW` cut from `next` Monday 13:00 UTC. A fix PR is auto-retargeted onto it. Admission closes Wednesday 13:00 UTC. The assembled train gets the full matrix, then one human approval via an `environment`. It lands on `next` by **rebase-merge**, so history stays linear, each fix stays its own commit, and `release.yml`'s `git cherry` hotfix pick keeps working [R §4.6].
3. **Admission gate:** machine-checked (7 existing required contexts + `Train report` + `Train repro` + `Train window`) plus one approving review. Queue entry is the admission act. Humans judge scope and design; machines judge format, sha binding, and whether the failing-first claim reproduces.
4. **Self-test report:** a fenced JSON block in the PR body, bound to the PR head sha. CI re-runs the named failing-first test on base (must fail) and head (must pass). The report is triage signal and an effort gate, never proof of correctness. A local run cannot be attested [D][§6.4].
5. **Measured problem:** 62 of 79 open PRs are `BEHIND`, 10 `DIRTY`; 41% of merged fix PRs were force-pushed at least once; 24 of the 120 merges audited in #4990 landed behind `next` via admin merge [M §2].
6. **Prior art in this repo:** a merge-queue-readiness change (#4999) was reverted in full (#5001) as scope expansion. The rollout below is settings-first and one workflow at a time [§8].
7. **Biggest design tension:** a merge queue has one merge method per branch [D]. Queue on `next` + linear history forces either one squash for the whole train (loses per-fix commits) or rebase for every PR (7 commits per fix PR on average). So the queue goes on the *train* branch, not `next` [§4.6].
8. **Kill criterion:** if after 4 trains the median fix-PR "landings while open" is not below 2, or two trains needed an eject-and-rerun to ship, fall back to queue-on-`next` only [§8.3].

---

## 2. Evidence: how bad is "chasing `next`"

Repo: `open-gsd/gsd-core`. Window unless stated: **2026-09-21 to 2026-10-21** (30 days). Every figure is re-derivable with the commands below. GitHub's search API and run listings cap at 1000 results, so longer windows were truncated and are not used.

### 2.1 Commands

```bash
R=open-gsd/gsd-core
# merged PRs into next (search capped at 1000: it started at 2026-08-04), then restrict to the window:
gh pr list -R $R --state merged --base next --search "merged:>=2026-07-23" --limit 1000 \
  --json number,title,createdAt,mergedAt,labels,author,headRefName,isCrossRepository
jq '[.[]|select(.mergedAt>="2026-09-21")]' merged.json                                  # 230 PRs
# per fix/ PR timeline (force-push counts):
gh api "repos/$R/issues/$N/timeline?per_page=100" --paginate --jq '.[]|.event' | sort | uniq -c
# open PR merge state:
gh pr list -R $R --state open --limit 500 --json number,createdAt,baseRefName,labels,mergeStateStatus,isCrossRepository
# first-parent landings on next, for "landings while a PR was open":
git log origin/next --first-parent --since=2026-09-14 --format=%ct
# CI:
gh api "repos/$R/actions/workflows/test.yml/runs?branch=next&event=push&created=2026-09-21..2026-10-21&per_page=100" --paginate
gh api "repos/$R/actions/workflows/test.yml/runs?created=2026-09-21..2026-10-21&per_page=100" --paginate   # capped: covers 2026-10-13..10-21 only
# settings:
gh api repos/$R --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,allow_auto_merge}'
gh api repos/$R/branches/next/protection ; gh api repos/$R/rulesets ; gh api repos/$R/rulesets/16752567
```

A first attempt used GraphQL `timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){totalCount}`. It returned 7 to 210 per PR, including PRs whose REST timeline shows zero force-pushes, so that count is not filtered as expected. **Discarded.** The REST timeline numbers below replace it.

### 2.2 Results

| What | Value | Source |
|---|---|---|
| PRs merged into `next` | 230 (139 `fix/` = 60%; 64 from forks = 28%; 164 by the maintainer = 71%) | [M] merged.json |
| First-parent commits on `next` | 255 in 30 days = 8.5/day | [M] `git log --first-parent` |
| All-PR median open-to-merge | 2.4 h; p90 141 h | [M] |
| `fix/` PR open-to-merge | p50 6.5 h; p75 72 h; p90 163 h | [M] |
| Fork PR open-to-merge | p50 108 h; p90 335 h | [M] |
| Landings on `next` while a `fix/` PR was open | median 4; p75 30; p90 61; max 189; 119 of 139 PRs saw at least one; 62 saw five or more | [M] |
| `fix/` PRs with at least one `head_ref_force_pushed` | 57 of 139 (41%); 148 force-pushes total; max 12 | [M] REST timeline |
| `fix/` PR size | median 5 files, 199 changed lines; mean 7.0 commits per PR | [M] GraphQL |
| Currently open PRs by `mergeStateStatus` | `BEHIND` 62, `DIRTY` 10, `BLOCKED` 6, `UNKNOWN` 1 (of 79; 73 are forks) | [M] open.json |
| Open PRs with `needs-review: merge-conflict` | 14 of 79 | [M] |
| Open `confirmed-bug` issues | 96; median age 10 days; p90 25 days | [M] |
| `Tests` push runs on `next` | 231; 217 success, 12 failure, 2 cancelled (5.2% red); 12 separate red episodes | [M] |
| Re-run attempts | 1 of 231 push runs; 19 of 1000 runs in the 8-day window | [M] |
| PR-event `Tests` runs (2026-10-13 to 10-21 only) | 548 success, 125 failure, 173 cancelled, 42 `action_required` (fork approval) | [M] |
| PR branches with a failed `Tests` run in that window | 74 of 174; 66 of those later went green | [M] |
| Median wall time of a green PR `Tests` run | 31.5 min; p90 65.4 min (`run_started_at` to `updated_at`, approximate) | [M] |
| Reverts on `next` | 1 of 255 (be6d07c08d, a CI-tooling change, not a bug fix) | [M] |
| Repo merge settings | squash, merge-commit and rebase **all enabled**; auto-merge enabled; `docs/branching.md` says rebase should be OFF | [M] `gh api repos/$R` |
| `next` protection (classic) | `strict: true`, 1 approving review, `enforce_admins: false`, 7 required contexts | [M] |
| Rulesets | `main-protection`, `release-branches`, `tag-immutability` exist with `enforcement: evaluate` and no bypass actors. `main-protection` targets `~DEFAULT_BRANCH` (= `next`) and includes `required_linear_history` | [M] |

Reading, not conclusion: the median fix PR merges within hours, so for most fixes the chase is short. The cost sits in the tail: 62 PRs saw five or more landings, and each landing on a `strict` branch is a rebase, a new sha, and per CONTRIBUTING.md a full re-verification plus another CI cycle (`CONTRIBUTING.md` lines ~152-165, "rebase last"). The fork tail (median 108 h) is where `BEHIND` accumulates, and a fork contributor cannot be asked to run the maintainer's bench.

### 2.3 Evidence already in the tracker

Issue #4990 (closed) audited the same problem in September 2026: "24 of 120 merges landed while BEHIND `next` (strict up-to-date bypassed by admin merge)", for example #4540 merged one commit behind #4549, both touching `execute-plan.md`, "and the combined tree (tested by neither PR) broke the `SIZE: workflow tier hard caps` gate on all three OSes". It also counted 26 red of 300 `next` push runs. That is the **semantic-conflict-between-green-PRs** failure mode, observed here, not hypothetical. Read with `gh issue view 4990 -R open-gsd/gsd-core`.

### 2.4 What I could not measure

- **Flake rate.** Re-runs are 0.4% to 1.9%, but repo policy forbids re-running to green (bug-fixer.md lines 733, 940, 945-946, 1088), so re-run counts understate flakiness. No honest flake rate exists.
- **Changeset conflicts.** Fragments have unique names (`.changeset/README.md`), so textual conflicts should be near zero. I did not measure conflicts in `CONTEXT.md`, `docs/INVENTORY.md` or manifests, which are the shared files bug-fixer.md lines 470-476 warn about.
- **Fix-forward frequency.** No reliable commit-message signal; not counted.
- **How many fix PRs were rebased *only* because `next` moved.** A force-push can also be an amend. 41% is an upper bound on rebase-driven pushes.
- **Staleness before 2026-08-04** (search cap).

---

## 3. Alternatives

| Option | What it fixes | What it does not | Fit here |
|---|---|---|---|
| **A. Status quo** (`strict`, rebase, admin-merge past BEHIND) | nothing | treadmill; 24/120 BEHIND admin merges (#4990) | baseline |
| **B. GitHub merge queue on `next`** | no manual rebase: the queue builds the PR on top of those ahead of it and the base [D]; tests the real merge result | one merge method for the whole branch [D]; no batching of intent; no submitter report; no time-box | **Phase-0 candidate.** Method conflict, see §4.6 |
| **C. Time-boxed train + queue on train (this memo)** | B's benefit for fixes, plus quarantine from feature churn, one reviewable unit, a cutoff to anchor submitter reports | second integration layer; sync with `next`; close-time failures | **Recommended** |
| **D. Long-lived `release/*` branch with scheduled cutoff** | stabilization | already exists for minor/major releases (`docs/branching.md` Flow 3); not a bug-fix cadence | complementary |
| **E. Rolling staging branch + rollups (Bors/Rust)** | batches PRs, tests once. Rust: "every PR must be tested after merge" and long CI "scales poorly" with PR volume, so low-risk PRs are batched [X: https://forge.rust-lang.org/release/rollups.html] | needs a bot; on failure the rollup is rebuilt without the culprit [X same page] | closest analogue to the close step; GitHub's queue replaces the bot |
| **F. Kubernetes-style freeze** | Tide merge requirements change at freeze: PRs must be in the current release milestone [X: https://github.com/kubernetes/sig-release/blob/master/release-engineering/handbooks/release-manager.md]. The handbook calls the blocking mechanisms "relatively weak", so the release manager is "the last line of defense" [X same page] | a policy gate, not a test gate; needs a human owner | borrowed: milestone as the time-box, `Train window` check |
| **G. Chromium-style commit queue** | dry run (CQ+1) vs full run (CQ+2) that submits; failed shards are retried, and a failure that also fails without the patch is ignored [X: https://chromium.googlesource.com/chromium/src/+/main/docs/infra/cq.md] | "ignore if it fails on tip" conflicts with this repo's no-waving-off rule | borrowed: *control run on base* as attribution only, never as an exemption |
| **H. Stacked PRs** | branches build on one another; merge bottom-up; work with merge queue; "if one is removed or ejected, the ones above it are removed too" [D: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests] | for dependent changes by one author, not independent fixes from many; GA status **UNVERIFIED** (page does not say); no auto-merge for stacks [D] | not suitable |
| **I. Prow Tide batch merge** | "Automatically runs batch tests and merges multiple PRs together whenever possible" [X: https://docs.prow.k8s.io/docs/components/core/tide/] | failed-batch behavior not on the page I read: **UNVERIFIED** | reference only; needs Prow |

**Honest comparison B versus C.** B alone addresses the measured pain with less machinery. C earns its extra layer only through (1) one human gate on a coherent unit, (2) a predictable cutoff that makes the submitter report practical, and (3) keeping fix churn off the branch features land on. If none of those is wanted, choose B and skip the rest of this memo.

---

## 4. Design

### 4.1 Branch model and lifecycle

| Item | Proposal [R] |
|---|---|
| Name | `train/YYYY-wWW` (ISO week, e.g. `train/2026-w44`). Matches ruleset pattern `refs/heads/train/**`; fnmatch `**` is documented [D: https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization]. Needs a `train/` prefix in `branch-naming.yml`. `pr-target-validator.yml` already classifies other targets as `unusual`, not blocked (`scripts/pr-target-policy.cjs` lines 51-57). |
| Cadence | Weekly. Data: fix PR p75 open time is 72 h and p90 is 163 h, so a weekly window lets roughly 75% of fixes admit in their first window; the rest roll. A daily train would cut every fork PR (median 108 h). |
| Open | Monday 13:00 UTC (09:00 EDT). `schedule` cron runs in UTC by default and an IANA timezone may be set [D: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows]. Scheduled workflows run only on the default branch (`next` is the default) and can be delayed under load [D same page]. The workflow creates the branch from the `next` tip and a milestone `train 2026-w44` whose **due date is the admission cutoff**. |
| Admission cutoff | Wednesday 13:00 UTC. A required check `Train window` fails for PRs targeting a train whose milestone due date has passed, unless the maintainer applies `train:exception` (label write needs repo write access, as with `fix-next`, `CONTRIBUTING.md` ~1318). This is the GitHub analogue of Kubernetes changing merge requirements at freeze [X], with no ruleset API call. |
| Soak and verify | Wednesday 13:00 to Thursday 13:00 UTC. Full matrix on the assembled train tip (§4.2). Only `train:exception` PRs and eject-reverts may still enter. |
| Close | Thursday 13:00 UTC, after human approval via `environment: ship-train` (§4.3). **No Friday merges.** |
| Late submissions | A PR that misses the cutoff keeps its place: the next `open-train` run retargets every open PR still pointing at the closed train to the new one (`gh pr edit --base`). The PR becomes `BEHIND` once, at window cadence, not per landing. |
| Retargeting new PRs | Authors keep opening `fix/*` PRs against `next`. A `pull_request_target` workflow retargets a `fix/*` PR (without `train:skip`) to the open train. This preserves `CONTRIBUTING.md`'s "you PR to next" rule and the issue-first flow. |
| Escape hatches | `train:skip` label: PR stays on `next` (urgent, or touches `.github/workflows/**` or release machinery). `fix/critical-*` and `hotfix/*` unchanged (`docs/branching.md`). |
| Milestone | One per train. Membership is queryable (`gh pr list --search "milestone:..."`), which makes the close PR body and report generation mechanical. The repo has 0 milestones today [M `gh api repos/$R/milestones`]. |
| Issue closing | **GitHub ignores closing keywords for PRs that do not target the default branch** ("these keywords are ignored, no links are created, and merging the PR has no effect on the issues") [D: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue]. A member merged into `train/*` does not close its issue. The close PR body therefore lists every member's `Fixes #N`, and the issues close when it lands on `next`. bug-fixer.md step 6.7 (lines 1007-1010) must expect this. |

### 4.2 CI sequencing

Three levels, each with a different job.

| Level | Trigger | Runs | Why |
|---|---|---|---|
| **L1 PR into train** | `pull_request` (base `train/**`) | Existing metadata checks (`check-branch`, `changeset-lint`, `docs-lint`, `validate-target`, `Issue link required`, `Pull request template format`) + `Train report` + `Train repro` + `Train window`. Heavy lanes sit behind the `PR mergeability` preflight as today. | Cheap early rejection. Report and repro cost minutes, not the 31 min matrix. |
| **L2 queue entry** | `merge_group` on the train branch | `Required tests` (the existing aggregate, incl. Windows/macOS where the classifier says so) on the exact "PR + queue ahead + train tip" commit | The queue tests the combination nobody could by hand. `test.yml` already has `merge_group:` (#4241); the six metadata workflows do **not** (#4990 table) and would deadlock the queue, so they need the trigger. [D: "You must use the `merge_group` event…" https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue ; events page] |
| **L3 assembled train** | `push` to `train/**` + `workflow_dispatch` at close | Full parity matrix (`full_matrix` path in `scripts/ci-test-scope.cjs`: Windows, macOS, install/slow) on the train tip merged with the current `next` | L2 may use the scoped matrix per PR; L3 proves the sum, including after the daily `next` sync. |

Wiring gaps found in the repo [M]:
- `test.yml` triggers on `pull_request: branches: [next, main]` and `push: branches: [next, main, release/**, hotfix/**]`. A PR to `train/**` would run **no** `Tests`. Add `train/**` to both. `install-smoke.yml`, `mutation.yml` and `security-scan.yml` list `next`/`main` only: same edit. `version-gate.yml` is main-only: untouched.
- `Base branch health` (`scripts/ci-next-health.cjs`, `test.yml` ~lines 44-55) queries the base branch's last push-triggered `Tests` run. With a `train/**` push trigger it can work on the train branch; behavior with no prior run is **UNVERIFIED**.
- `changeset-required.yml` reads `github.event.pull_request.base.ref` (lines ~36-49), so it is base-agnostic.

**Sync with `next`.** A scheduled job brings `next` into the train daily, then L3 runs. This is where semantic conflicts between a fix and a feature surface: once a day instead of at close. If the sync is not clean the job labels the train `train:needs-sync` and the captain resolves it. How the sync is done interacts with the close method: the close PR is rebase-merged (§4.6), which replays commits, and whether a rebase-merge of a branch holding merge commits flattens as wanted is **UNVERIFIED**. The safe form is to `git rebase` the (bot-owned, ephemeral) train onto `next` before the freeze. Decide in Phase 1.

**Failing member, bisect, eject.** Every member passed L2 before admission, so a red L3 is almost always (a) the `next` sync or (b) an environment failure. Procedure, consistent with repo policy:

1. **Control run.** Run the failing test(s) on the `next` tip. Red on `next` too: the train is not at fault; use the existing `fix-next` path. Chromium uses the same with-patch versus without-patch logic [X cq.md] but then *ignores* the failure; this repo does not (bug-fixer.md lines 733, 940, 945), so the control run is **attribution only**.
2. **Bisect.** The train is a linear stack of squash commits, so plain `git bisect run` over `next..train` with the failing test as predicate works; `--first-parent` is only needed when merge commits exist, and then it reports the merge itself and does not examine merged commits individually [D: https://git-scm.com/docs/git-bisect]. O(log n) targeted runs, not full matrices.
3. **Eject.** `git revert` the culprit's squash commit on the train (append-only; the ruleset forbids force-push), set the PR to `train:ejected`, comment with the bisect log. Rust's equivalent is to unapprove the offender and rebuild the rollup without it [X rollups.html]. A revert pair costs two commits of noise; the alternative (rebuild the branch) needs a force-push bypass actor.
4. **Vanishing failure.** A failure that does not reproduce is **not** exempt (bug-fixer.md line 945: "Never re-run it away"). The close stays blocked until the mechanism is found or the maintainer decides. One diagnostic re-run is allowed to *gather evidence*; a green result does not flip the verdict.

### 4.3 Approval and admission gate

| Check | Who | Where enforced |
|---|---|---|
| Linked issue labelled `confirmed-bug` | machine | existing `Issue link required` |
| Branch name, title, template format, changeset, docs, target | machine | existing contexts |
| `Train report` present, well-formed, sha-bound | machine | new, §6 |
| `Train repro`: failing-first reproduced by CI | machine | new, §6 |
| `Train window` open | machine | new, §4.1 |
| Scope: fix addresses the issue only; design acceptable; negative space | **human** | one approving review. CODEOWNERS is advisory today (`.github/CODEOWNERS` header; `require_code_owner_review: false`). To make it binding, set it in the ruleset; the file must be on the PR's base branch [D: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners], which `train/**` satisfies by being cut from `next`. |
| Queue entry (the admission act) | automatic once review and checks pass | merge queue: "Merge when ready"; `gh pr merge` adds the PR to the queue if checks passed, otherwise enables auto-merge [D: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue] |
| **Ship the train** | **human, once per train** | `environment: ship-train` with required reviewers. Up to 6 reviewers, one approval suffices; "prevent self-review" is an optional setting [D: https://docs.github.com/en/actions/how-tos/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment]. Environment secrets are available only after the rules pass [D same page]. |

Why the environment sits on *ship*, not on each fix: an environment approval gates a workflow run's job [D: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments], which maps naturally to "one deployment". Per fix it would mean one waiting workflow run per PR. Per-fix admission uses the ruleset review requirement instead.

**Sole-maintainer reality [M].** 71% of merged PRs are authored by one account, bug-fixer.md lines 39-41 and 996-1003 use `--admin` for the "missing secondary reviewer" case, and #4990 counted 24/120 BEHIND admin merges. A required review on every train admission would reproduce that. Options are in §9 decision 3.

### 4.4 Failure modes of batch-merge

| Failure mode | Seen here? | Mitigation |
|---|---|---|
| One bad fix poisons the train | not yet (no trains) | L2 admission test per member; L3 bisect + revert-eject (§4.2) |
| Semantic conflict between individually green fixes | **Yes**: #4540/#4549 (#4990) | queue builds the PR on top of those ahead [D]; daily `next` sync + L3 |
| Semantic conflict between a fix and a feature on `next` | likely | daily sync, L3 on the merged-with-`next` tip |
| Bisectability lost | n/a | rebase-merge close keeps one commit per fix on `next` (§4.6) |
| Eject churn | n/a | append-only revert; the PR re-queues on the next train |
| Changeset/CHANGELOG conflicts | designed out: one file per PR | `pr:` must be the **member PR number**; the `pr:0` backfill step (bug-fixer.md lines 881-886, 901-920) is unchanged |
| Shared mutable files (`docs/FEATURES.md` counter, manifests) | bug-fixer.md lines 470-497 | unchanged: fragment pattern + fleet leases. A train raises collision odds within a window, so keep them fragment-based |
| Starvation of slow PRs | likely for forks (108 h median) | auto-roll to the next train; cutoff stated in the bot comment |
| Silent admin bypass | **Yes**: 24/120 | no bypass actors on the `train/**` ruleset; `enforcement: active` after evaluation |
| Release machinery regression | `release.yml` picks `fix:`/`chore:` commits by `git cherry $BASE_TAG $SOURCE` (lines 199-202) | linear history keeps per-fix commits visible; behavior with merge commits **UNVERIFIED**, avoided by §4.6 |

### 4.5 `gsd-test` local verdicts in the flow

`gsd-test --base next --head <40-hex>` clones, merges head onto base and runs the matrix on private Benches; the pre-push gate records a sha-bound marker only on a genuine `passed` (`.claude/skills/gsd-test-verify/SKILL.md` steps 3-6; bug-fixer.md lines 327-363). Implications:

- **Base moves from `next` to the train.** `--base <train>` tests the fix merged onto the train, the real admission context. Hard-coded `next` lives in `.claude/hooks/pre-pr-gate.sh` (candidate list line 151: `origin/next next origin/main main`; deny text lines 328 and 415 `--base next`) and in the skill's step 1 (`git diff --name-only origin/next...HEAD`). On a train-based branch that diff would list **every file already on the train**, wrongly deciding a push is not doc-only. These are user-owned hooks; this memo only flags them.
- **The sha invalidation rule stays**, but its cost drops: with a queue, no rebase is needed to admit, so the "rebase last" step (CONTRIBUTING.md ~162-166; bug-fixer.md lines 858-865) disappears in the common case.
- **Report generation for maintainer and agent PRs** reads the verdict line (`{"type":"verdict","outcome":"passed"}`) and the recorded sha and fills the report block automatically (§6.1).
- **External contributors have no Bench.** CONTRIBUTING.md lines ~1030-1035 already ask for the open-source `gsd-test-runner` summary "when you can". The schema therefore accepts `tool.name` of `gsd-test`, `npm-test` or `manual` and does not pretend they are equivalent (§6.4).

### 4.6 Close: merge method and history

| Method | Result | Verdict |
|---|---|---|
| **Squash** the train into one commit | one commit per train | Loses per-fix commits: `git bisect` stops at the train, and `release.yml` hotfix selection (one `fix:` commit per fix) turns into one giant pick. **Reject.** |
| **Merge commit** (`--no-ff`) | members preserved; train visible as a merge; `--first-parent` bisect finds the train, then bisect inside [D git-bisect] | Needs `required_linear_history` off for `next`. The live `main-protection` ruleset targets `~DEFAULT_BRANCH` and enables it; `docs/branch-protection.md` says merge commits are needed for release/hotfix back-merges only. Rust prefers the opposite: "merge commits in PRs are not accepted", for "the generally linear commit history" that simplifies bisecting [X: https://rustc-dev-guide.rust-lang.org/git.html]. |
| **Rebase-merge** | each member's squash commit lands linearly on `next`; allowed by `allowed_merge_methods: ["squash","rebase"]`; compatible with linear history | **Recommended.** `allow_rebase_merge` is already `true` [M]. Provenance is kept by a `Train: 2026-w44` trailer in every member's squash message plus an annotated tag `train/2026-w44` on the last commit (tags are covered by the immutability ruleset). |

The tested tree equals the landed tree only if the train is exactly current with `next` at merge time. `strict` guarantees that. So the close PR into `next` keeps `strict: true`, and the close step starts a short **freeze of other merges to `next`** (a `Train freeze` required check on non-train PRs while `ship-train` is pending, or a manual convention) to prevent a BEHIND loop for about 1 to 2 hours. That is the cost of **not** putting a queue on `next`.

Why no queue on `next` in Phase 1: a merge queue has exactly one merge method [D: managing-a-merge-queue; the REST `merge_queue` rule has a single `merge_method` of `MERGE|SQUASH|REBASE`, https://docs.github.com/en/rest/repos/rules]. On `next` that method would apply to **every** queued PR. `SQUASH` squashes the train (rejected above). `REBASE` lands every ordinary PR as its full commit list (fix PRs average 7.0 commits [M]). `MERGE` breaks the squash convention (`docs/branching.md`). The train branch has no such conflict: its queue uses `SQUASH` (one commit per fix). Revisit if the maintainer prefers queue-on-`next`.

---

## 5. Settings checklist and ruleset (ready to use)

Nothing here is applied. In order:

1. Repo > Settings > General > Pull Requests: keep squash and rebase ON; leave merge commits ON while `auto-backmerge.yml` needs them; auto-merge and delete-head-branches are already ON.
2. Create environment `ship-train`: required reviewers = maintainers (up to 6 [D]); "prevent self-review" if a second maintainer exists; deployment branches = `next` only (the workflow runs from the default branch).
3. Create labels `train:skip`, `train:exception`, `train:needs-report`, `train:ejected`, `train:needs-sync`. Existing and relevant: `fix-pending`, `fix-released`, `fix-next`, `needs rebase`, `confirmed-bug`.
4. Add the ruleset below with `enforcement: "evaluate"` first. The REST docs say `evaluate` is "only available with GitHub Enterprise" [D: https://docs.github.com/en/rest/repos/rules], yet the three live rulesets are already `evaluate` [M], so this org evidently has it. Review hits with `rule-suites` (`docs/branch-protection.md`, "Reading evaluate-mode logs").
5. Add `merge_group:` to the six metadata workflows (#4990 list) when a queue is enabled for the train branch.
6. Add `train/**` to the `test.yml`, `install-smoke.yml`, `mutation.yml` and `security-scan.yml` branch filters.

`.github/rulesets/train-branches.json` (shape follows `.github/rulesets/main-protection.json`; parameter names from the REST docs [D: https://docs.github.com/en/rest/repos/rules]):

```json
{
  "name": "train-branches",
  "target": "branch",
  "enforcement": "evaluate",
  "conditions": { "ref_name": { "include": ["refs/heads/train/**"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Required tests" },
          { "context": "check-branch" },
          { "context": "changeset-lint" },
          { "context": "docs-lint" },
          { "context": "validate-target" },
          { "context": "Issue link required" },
          { "context": "Pull request template format" },
          { "context": "Train report" },
          { "context": "Train repro" },
          { "context": "Train window" }
        ]
      }
    },
    {
      "type": "merge_queue",
      "parameters": {
        "check_response_timeout_minutes": "MAINTAINER_DECISION_SEE_NOTE_1",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 3,
        "max_entries_to_merge": 3,
        "merge_method": "SQUASH",
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 5
      }
    }
  ]
}
```

Notes on the values [R]:
1. `check_response_timeout_minutes` is a required integer (schema range 1 to 360) [D]. I left it as a placeholder on purpose: it is the maintainer's call, not mine to set. Input for the decision: the measured p90 of a green PR `Tests` run is 65.4 min and the median is 31.5 min (§2.2). Replace the string with an integer before applying; the file is not valid JSON-schema as written.
2. `strict_required_status_checks_policy: false` because the queue, not the author, keeps the entry current. That the queue makes the strict flag unnecessary is inferred from the queue description and the #4990 text; it is **UNVERIFIED**. Test in `evaluate`.
3. `max_entries_to_merge: 3` bounds the blast radius of a batch: a failed group of three is cheap to attribute. `ALLGREEN` requires the whole group green (`HEADGREEN` is the other documented value [D]).
4. `dismiss_stale_reviews_on_push: true` matches `main-protection.json`; it costs a re-approval after a force-push, and the queue makes force-pushes rare.
5. "Require merge queue" cannot be set in organization-level rulesets, only repository-level [D: search result for https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets]. A repo-level file fits `.github/rulesets/` and `scripts/sync-rulesets.sh`.

`next` keeps its classic protection and `main-protection` stays as-is. **Do not** add a queue to `next` in Phase 1 (§4.6).

---

## 6. Submitter self-test report

### 6.1 Format

PR templates are Markdown files [D: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository]; the page describes no form schema (YAML PR forms: **UNVERIFIED**). So the structured data is a **fenced JSON block between HTML-comment markers** in the PR body. This repo already parses PR bodies in CI (`pr-template-format.yml`, `require-issue-link.yml`), so the pattern is established.

Why body, not a committed file: a committed report cannot contain its own commit sha. A body block can name `head_sha`, stays editable without a new commit, and goes stale on every push, which is the point.

Schema (`schemas/train-report.v1.json`, sketch):

```jsonc
{
  "schema": "gsd-train-report/1",
  "issue": 5496,
  "author": "octocat",                       // must equal the PR author
  "head_sha": "<40-hex>",                    // must equal the PR head at validation time
  "base": { "ref": "train/2026-w44", "sha": "<40-hex>" },   // sha must be an ancestor of head_sha
  "environment": { "os": "darwin|linux|win32", "arch": "arm64", "node": "24.x.y", "npm": "11.x.y", "git": "2.5x.y" },
  "tool": { "name": "gsd-test|npm-test|manual", "version": "1.8.0", "run_ref": "<bench run id or null>" },
  "failing_first": {
    "tests": [ { "file": "tests/foo.test.cjs", "name": "rejects trailing comma" } ],
    "command": "node --test tests/foo.test.cjs",
    "on_base": { "sha": "<base sha>", "exit_code": 1, "excerpt": "<=40 lines showing the failure>" },
    "on_head": { "sha": "<head_sha>", "exit_code": 0, "excerpt": "<=40 lines showing it passing>" }
  },
  "full_suite": { "command": "npm test", "exit_code": 0, "pass": 2481, "fail": 0, "skip": 3, "excerpt": "<last 20 lines>" },
  "lint": { "command": "npm run lint:ci", "exit_code": 0 },
  "platforms_run": ["linux"],                // honest list; CI covers the rest
  "not_run": ["windows"],                    // required: say what you did NOT run
  "generated_at": "2026-10-21T14:03:00Z"
}
```

For maintainer and agent PRs a generator (new `scripts/train/report.cjs`, not written here) assembles it from `.gsd/bug/<slug>/50-test-matrix.md` (the "RED proven" sha), `00-run.json`, `80-ship.json` (`verdict_sha`) and the recorded `gsd-test` verdict. For external contributors, `scripts/train/report.cjs --run` would execute the failing-first and full-suite commands in a temp worktree and print the block.

### 6.2 PR template section (add to `.github/PULL_REQUEST_TEMPLATE/fix.md`, replacing "How I verified the fix")

````markdown
## Self-test report

> **Required for fixes.** Generate it with `node scripts/train/report.cjs --run` (or paste your `gsd-test` summary into `tool`). CI re-runs the failing-first test; this report tells reviewers what you ran and lets CI reject a stale or malformed one. It is not a substitute for CI.

<!-- train-report:begin -->
```json
{ "schema": "gsd-train-report/1" }
```
<!-- train-report:end -->

- [ ] The test listed under `failing_first` **fails on the base** and **passes on my head commit**.
- [ ] `not_run` lists every platform I did not run (CI covers the matrix).
````

### 6.3 Validator: what runs and where

Two workflows, split by trust. GitHub's guidance: workflows on privileged triggers "must not explicitly check out untrusted code", and `workflow_run` is the better choice for privilege separation [D: https://docs.github.com/en/actions/reference/security/secure-use]. The repo already follows this: `pr-target-validator.yml` uses `pull_request_target`, checks out only the **base** branch with `persist-credentials: false`, and reads PR-controlled inputs as data.

| Workflow (check name) | Trigger | Checks out | Token | Does |
|---|---|---|---|---|
| `train-report-format.yml` (`Train report`) | `pull_request_target` [opened, edited, synchronize, reopened] | **base** only | `pull-requests: write` | parse the body block; schema; `head_sha == pr.head.sha`; `author == pr.user.login`; `base.sha` is an ancestor of head; named test files appear in the PR diff under `tests/`; `generated_at` not before the first PR commit and not in the future; excerpts non-empty and containing the test name; no home-directory paths (the `bug_report.yml` privacy notice). Applies/removes `train:needs-report`. |
| `train-repro.yml` (`Train repro`) | `pull_request` (contributor code runs here: **no secrets**, `contents: read`) | PR merge ref | read-only | (1) overlay the PR's `tests/**` changes on the **base** checkout and run the named tests: **must fail**; (2) run them on head: **must pass**. The full-suite command in the report is *not* re-run here; that is `Required tests`. Uploads `repro.json`. |
| `train-report-publish.yml` (optional) | `workflow_run` on `train-repro` | none | `pull-requests: write` | reads `repro.json` as **data**, posts one sticky comment, applies labels. Needed because a fork `pull_request` token cannot write, and events created by `GITHUB_TOKEN` do not start new runs apart from `workflow_dispatch`/`repository_dispatch` [D: https://docs.github.com/en/actions/concepts/security/github_token]. |

Fork gates: workflow runs for fork PRs may require manual approval, and an unapproved run expires after 30 days [D: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks]; 42 `action_required` runs in the 8-day window [M] show it is exercised here. Keep that setting; the repro job executes contributor code.

Skeletons (action pins copied from existing workflows; `scripts/train/*.cjs` do not exist and are the new code Phase 2 adds):

```yaml
# .github/workflows/train-report-format.yml
name: Train report format
on:
  pull_request_target:
    types: [opened, edited, reopened, synchronize]
    branches: ['train/**']
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: train-report-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  report:
    name: Train report            # this string is the required context
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2 -- BASE ref only
        with:
          ref: ${{ github.event.pull_request.base.ref }}
          persist-credentials: false
          fetch-depth: 0
      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3  # v9.0.0
        env:
          PR_BODY: ${{ github.event.pull_request.body }}   # via env, never interpolated into script text
        with:
          script: |
            const { validateReport } = require(`${process.env.GITHUB_WORKSPACE}/scripts/train/validate-report.cjs`);
            const res = await validateReport({ body: process.env.PR_BODY, pr: context.payload.pull_request, github, context });
            if (!res.ok) core.setFailed(res.errors.join('\n'));
```

```yaml
# .github/workflows/train-repro.yml  (runs contributor code: NO secrets, read-only)
name: Train repro
on:
  pull_request:
    branches: ['train/**']
permissions:
  contents: read
jobs:
  repro:
    name: Train repro
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@<pinned-sha>      # Node from .nvmrc
        with: { node-version-file: .nvmrc }
      - run: npm ci --ignore-scripts
      - name: Write PR body to a file (as data)
        env: { PR_BODY: "${{ github.event.pull_request.body }}" }
        run: printf '%s' "$PR_BODY" > "$RUNNER_TEMP/body.md"
      - name: Failing-first on BASE (must fail)
        run: node scripts/train/repro.cjs --body "$RUNNER_TEMP/body.md" --mode base   # overlay PR tests/** on base; exit 0 iff the named tests FAIL
      - name: Pass on HEAD (must pass)
        run: node scripts/train/repro.cjs --body "$RUNNER_TEMP/body.md" --mode head
```

`node --test` is fine on a CI runner; the "never run `node --test` locally" rule is a workstation hook (`block-local-node-test.sh`, bug-fixer.md line 360).

**Open and close workflows (Phase 3), skeletons.** The one non-obvious constraint: a PR or push created with `GITHUB_TOKEN` does not trigger `pull_request`/`push` workflows [D: github_token page], so the close PR needs a GitHub App token or the maintainer's own token, or its required checks never report.

```yaml
# .github/workflows/open-train.yml
name: Open train
on:
  schedule: [{ cron: '0 13 * * 1', timezone: 'UTC' }]      # Mon 13:00 UTC; may be delayed under load [D]
  workflow_dispatch:
permissions:
  contents: write
  issues: write            # milestones
  pull-requests: write     # retarget leftovers
jobs:
  open:
    runs-on: ubuntu-latest
    env: { GH_TOKEN: "${{ github.token }}" }
    steps:
      - name: Create branch + milestone (idempotent)
        run: |
          NAME="train/$(date -u +%G-w%V)"
          SHA=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/next" --jq .object.sha)
          gh api -X POST "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/heads/$NAME" -f sha="$SHA" || echo "exists"
          DUE=$(date -u -d 'next wednesday 13:00' +%FT%TZ)
          gh api -X POST "repos/$GITHUB_REPOSITORY/milestones" -f title="$NAME" -f due_on="$DUE" || echo "exists"
          echo "train=$NAME" >> "$GITHUB_STEP_SUMMARY"
      - name: Retarget PRs still on a closed train
        run: |
          NEW="train/$(date -u +%G-w%V)"
          for pr in $(gh pr list --state open --json number,baseRefName --jq '.[]|select(.baseRefName|startswith("train/"))|select(.baseRefName!="'"$NEW"'")|.number'); do
            gh pr edit "$pr" --base "$NEW"
          done
```

```yaml
# .github/workflows/close-train.yml
name: Close train
on:
  workflow_dispatch:
    inputs: { train: { description: 'train/YYYY-wWW', required: true } }
permissions:
  contents: read
jobs:
  verify:                      # full matrix on the assembled train
    uses: ./.github/workflows/test.yml          # needs workflow_call in test.yml (it has workflow_dispatch only) [D: reusing-workflow-configurations]
  ship:
    needs: verify
    environment: ship-train    # required reviewers: the human gate for the whole unit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@<pinned-sha>
        id: app
        with: { app-id: "${{ vars.TRAIN_APP_ID }}", private-key: "${{ secrets.TRAIN_APP_KEY }}" }
      - name: Open the close PR with all Fixes lines, enable auto-merge (rebase)
        env: { GH_TOKEN: "${{ steps.app.outputs.token }}" }
        run: |
          # body: "Fixes #N" for each member PR in the milestone; list from `gh pr list --search "milestone:$TRAIN is:merged base:$TRAIN"`
          gh pr create --base next --head "${{ inputs.train }}" --title "chore: ship ${{ inputs.train }}" --body-file body.md
          gh pr merge "${{ inputs.train }}" --rebase --auto
```

(Reusable-workflow note: a caller job invokes a reusable workflow with `jobs.<id>.uses`; nesting is limited to ten levels [D: https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations]. Adding `workflow_call` to `test.yml` is a change to the repo's most load-bearing workflow and is a Phase 3 decision, not a given.)

### 6.4 Trust model: what a self-report can and cannot prove

| Claim | Provable by CI? | Notes |
|---|---|---|
| Report exists, parses, matches the schema | Yes | `Train report` |
| It refers to *this* head sha, this author, this base lineage | Yes | sha binding; stale after any push |
| The named test is in the diff and runs | Yes | `Train repro` |
| The test fails on base and passes on head | **Yes, by CI's own run** | the strongest check; it does not rely on the submitter's output |
| The submitter's full-suite result | **No** | CI's `Required tests` is the authority; reported counts are advisory |
| OS/Node/tool versions, or that they ran it at all | **No** | unfalsifiable from the repo |
| Output excerpts are genuine | **No** | editable; `Train repro` makes them irrelevant to correctness |
| Provenance via artifact attestation | **No, for local runs** | attestations are signed claims about builds produced in a GitHub Actions workflow: workflow, repository, commit, triggering event, OIDC identity [D: https://docs.github.com/en/actions/concepts/security/artifact-attestations]. A laptop run has none of that. Attesting the *CI* repro output is possible, but the page I read does not cover `actions/attest` or `attest-build-provenance` usage (**UNVERIFIED**) and the check run is already the record. |
| Check runs as a channel | n/a | only GitHub Apps can create check runs through the REST API [D: https://docs.github.com/en/rest/checks/runs]; Actions jobs already produce check runs, so no custom check-run code is needed. |

**Trust rule [R]:** CI re-runs are authoritative. The report is (1) a triage signal that tells a reviewer in 30 seconds what was and was not run, (2) an *effort gate*: a PR with no reproducible failing-first test is not admitted, and (3) a record for the close PR. A missing or malformed report blocks admission; a well-formed one never substitutes for a CI result. This matches the repo's stance that markers certify work and never replace it (bug-fixer.md lines 42-45).

**Fork security [D secure-use]:** the format check parses body text as data under `pull_request_target`, with only the base checked out and the body passed through an environment variable rather than interpolated into script text. Anything that executes contributor code (`Train repro`, `Required tests`) runs under `pull_request` with a read-only token and no secrets. Branch names, titles and bodies are untrusted input everywhere. Pin all actions to SHAs, as the repo already does.

---

## 7. How bug-fixer.md changes

Line numbers refer to `/Users/trekkie/.claude/commands/bug-fixer.md` (1129 lines). That file is user-owned; this section is a change list and nothing was edited.

| Lines | Current | Change |
|---|---|---|
| 15 | `BASE_BRANCH` … default `next` … "Branch every PR targets and rebases onto." | Keep `BASE_BRANCH=next` for non-defect work. Add `PR_BASE`, resolved in Phase A as the newest open `train/*` ref (`gh api repos/$REPO/git/matching-refs/heads/train/ --jq 'sort_by(.ref)|last|.ref'`), overridable by `--base`. Fall back to `next` when no train is open or the issue is `train:skip`. |
| 335, 911 | `gsd-test --base next --head <40-hex-sha>` / `--base next --bench <b>` | `--base $PR_BASE` (the real admission context). The hooks hard-code `next` (`pre-pr-gate.sh` lines 151, 328, 415) and need the same change or a train-aware candidate list. |
| 400-401 | `git log origin/$BASE_BRANCH --oneline --grep="#<n>"` | Also search `origin/$PR_BASE`. A fix admitted to the train is *not yet* on `next`; without this the sweep re-fixes issues already admitted. A PR merged into the train counts as "already fixed (admitted)" for guard (a); a queued or open PR for guard (b). |
| 415-418 | `closes/fixes/resolves #<n>` referenced by an open PR | Unchanged for the member PR, but GitHub ignores the keyword for a non-default base [D], so also match open and merged PRs whose base is `train/*` by milestone or by body text. |
| 450-451 | `git checkout --detach origin/$BASE_BRANCH` | `origin/$PR_BASE`. |
| 462-465 | fleet calls use `branch: "$BASE_BRANCH"`; rule at 313-317: the pool is keyed on the target branch | Keep the pool key `next` for **all** agents so `/feature-builder` (on `next`) and `/bug-fixer` (on a train) still see each other. Using the train name would split the pools and recreate the blindness described at 244-251. |
| 725-727 | commit the regression test, run `gsd-test` on that literal sha to confirm RED | Unchanged; also record the RED sha into the report's `failing_first.on_base`. |
| 858 | `git rebase origin/$BASE_BRANCH` | Only if the PR conflicts with `$PR_BASE`. Otherwise **skip**: the queue handles currency. This removes the re-verification at 863-865 in the common case. |
| 880-886 | changeset `--pr 0`, backfill | Unchanged. The fragment's `pr:` is the member PR number. |
| 891-892 | "Push and open against `$BASE_BRANCH`" | Open against `$PR_BASE`. The body must contain the §6.2 report block (generated). `GSD_PR_GATES_OK` unchanged. |
| 903-919 | doc-only carry-forward `--base next` | `--base $PR_BASE`. |
| 947-953 | handle BEHIND with `gh pr update-branch`; park if `next` moved again | Replace with: enter the queue (`gh pr merge <N> --squash --auto`; adds to the queue if checks passed, otherwise enables auto-merge [D]). BEHIND is no longer a state the sweep manages. The compare-API `behind_by` measure (949-951) is kept only for the **close** PR. |
| 955-978 | `80-ship.json` schema | Add `"train": "train/2026-w44"`, `"queue": "queued|admitted"`, `"report_head_sha"` (must equal the PR head). |
| 996-1006 | merge; `--admin` only for the missing secondary reviewer | `--admin` is unnecessary on a train PR if the train ruleset requires 0 or non-author approvals (decision 3). Raw API merges stay forbidden. `gsd-merge-authority-guard.cjs` must accept a PR base of `train/*` (**UNVERIFIED** how it keys on base). |
| 1007-1010 | "Confirm the linked issue closed" | A member merge does **not** close the issue (§4.1). Terminal for the sweep is `admitted`; the issue closes when the train lands. Add state `admitted` to `queue.json` (lines 425-427); a later run sets `shipped` by reconciling against the train tag. |
| 1011-1043 | re-index `branch: "next"` after merge | Re-index `branch: "$PR_BASE"` after admission, and `next` after the train lands. |
| 1111-1114 | halt the issue, never the queue | Add: an ejected PR (`train:ejected`) becomes `needs-decision` only if the bisect log shows the fix itself is wrong; an environment-caused eject re-queues. |

**Stays the same:** diagnosis (steps 1-2), failing-first TDD and the `gsd-test` classic executor on a literal 40-hex sha, both orthogonal reviews, the artifact gates (`10-`, `50-`, `60-`, `80-`), one concern per PR, "never write to a GitHub issue", `needs-decision` mechanics, flakes-do-not-exist.

**New awareness the sweep needs:** the train is a shared resource with a deadline. The sweep should stop opening PRs in the last two hours before cutoff (a p90 green run is 65 min and the queue adds wait) and leave them for the next train.

---

## 8. Rollout, risks, open questions

### 8.1 Phases (minimal first)

| Phase | Needs | Delivers | Exit check |
|---|---|---|---|
| **0. Decide** (now) | this memo | maintainer answers §9 | decisions 1-3 made |
| **1. Manual train, queue on train** | settings + two small workflow edits: `train/**` added to the `Tests`-family filters; `merge_group` added to the six metadata workflows; ruleset in `evaluate`. The maintainer cuts the branch by hand (`git push origin next:refs/heads/train/2026-w44`) and closes by hand (`gh pr create --base next --head train/…`, rebase-merge). **No bot, no secrets.** | queue + train + linear landing without automation risk | 2 trains shipped; BEHIND count on train PRs = 0 |
| **2. Submitter report** | `train-report-format.yml`, `train-repro.yml`, `scripts/train/*.cjs`, template section, a how-to in `docs/` | effort gate + CI-reproduced failing-first | report required in `evaluate`, then `active`; false-reject rate reviewed |
| **3. Automation** | `open-train.yml` (cron), retarget workflow, `Train window` check, `close-train.yml` with `environment: ship-train`; a GitHub App token for the close PR | weekly cadence without the maintainer's hands | one unattended cycle |
| **4. Eject and bisect** | `scripts/train/bisect.cjs`, `train:ejected` handling | attribution in minutes | first real eject exercised |
| **5. bug-fixer.md and hooks** | §7 table; `pre-pr-gate.sh` and verify-and-record updated for a train base | the unattended sweep targets the train | sweep admits N fixes and ends in `admitted` |

"What can be done with only repo settings and one workflow?" Phase 1: the ruleset, the `merge_group` triggers, the branch filters, and a manual cut/close.

### 8.2 Risks

| Risk | Mitigation |
|---|---|
| Repeat of #4999/#5001 (scope expansion: privileged back-merger, bot-token plumbing, reverted in full) | Phase 1 has no bot and no secrets; each phase is its own PR; this memo does not propose touching `auto-backmerge.yml` |
| Queue and `strict` disagree and deadlock merges | `evaluate` first; test on a throwaway `train/test-*` branch |
| `merge_group` missing on a required context → permanent stall | the six-workflow list is known (#4990 table); add before enabling the queue [D events page] |
| A queue group of three lets one slow Windows lane block three PRs | `max_entries_to_merge: 3`; watch Windows stalls (`docs/research/windows-ci-child-process-stalls.md` on branch `docs/5473-windows-ci-stall-research`) |
| Close blocked by a red `next` | the existing `Base branch health` gate and `fix-next` label apply to the close PR |
| Maintainer becomes train captain forever | rotate; `ship-train` allows up to 6 reviewers [D] |
| Report becomes ceremony | CI repro is the substance; fields beyond sha binding stay optional in schema `1` |
| Rebase-merge rewrites SHAs, so a sha in `80-ship.json` is not the landed sha | record the train tag and member PR numbers, not SHAs, in post-ship records |
| Release machinery assumes commits are reachable by `git cherry` | in Phase 1, dry-run `release.yml` `create` against a train-landed `next` (**UNVERIFIED** today) |

### 8.3 Kill criteria

After 4 trains: (a) median landings-while-open for `fix/` PRs still ≥ 2; or (b) two or more trains needed an eject-and-rerun to ship; or (c) maintainer hours per train (cut + sync + ship) exceed the rebase and re-verify hours saved. Then fall back to Option B (queue on `next`) and settle the merge-method question there.

### 8.4 Unverified items collected

- Whether the queue makes `strict_required_status_checks_policy` unnecessary on the train rule (inferred, not read).
- How a PR removed from the queue is surfaced (for labelling `train:ejected`): the docs list removal reasons, but `merge_group` supports only `checks_requested` [D events page].
- Whether `git cherry` and `release.yml` hotfix pick behave with merge commits on `next` (avoided by rebase-merge).
- Whether a GitHub rebase-merge flattens a branch containing merge commits (the train's sync commits) as wanted.
- `Base branch health` behavior with no prior push run on a new branch.
- `gsd-merge-authority-guard.cjs` and the `.cjs` hooks' hard-coded `next` (only `pre-pr-gate.sh` was inspected).
- `evaluate` enforcement availability (docs: Enterprise only; live rulesets already use it).
- Whether YAML-form PR templates exist (the docs page describes Markdown only).
- GA status of GitHub stacked PRs; Tide failed-batch behavior; `actions/attest` usage.
- Merge queue plan/visibility availability: "Managing a merge queue" does not state it. The repo is public in an org [M `visibility: public`], and #4241 treats the queue as a manual UI step.

---

## 9. Decisions the maintainer must make

1. **Is the train worth a second integration layer, or is queue-on-`next` enough?** The queue is what removes the rebase treadmill. The train adds one reviewable unit, a cutoff for submitter reports, and quarantine from feature churn, at the price of a sync layer and a close ritual. Recommendation: build the train as asked, with the 4-train kill criterion (§8.3). If you only want the pain gone, choose B and keep `next` as the single target.
2. **History shape at close, and the cadence.** Rebase-merge of the train onto `next` (linear, per-fix commits, `release.yml` untouched, provenance via trailer + tag) versus a merge commit (needs `required_linear_history` off for `next`). And the defaults: weekly, cut Mon 13:00 UTC, admission cutoff Wed 13:00 UTC, ship Thu 13:00 UTC, no Friday merges. Also the queue timeout value, which I left blank (§5 note 1) with the measured p90 of 65.4 min as input.
3. **Where the human approval lives.** A per-fix review on the train ruleset (1 approval; with one dominant author this reproduces admin merges), or 0 required on train PRs (like `main-protection.json`) with all human judgement concentrated at `ship-train` plus the closing PR's review. The second trades per-fix scrutiny for one deliberate gate; it is only safe if the machine checks in §4.3 are required and no bypass actors exist.
