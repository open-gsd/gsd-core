# `main` as "released", `next` as integration — is it right, and what are the options?

**Date:** 2026-10-21
**Trigger:** Maintainer question. They treat `main` as "released": whatever is current and released is `main`; `next` is where work integrates. (a) Is that a best practice? (b) If not, re-evaluate the whole model. Goals: (1) spend less on GitHub Actions minutes; (2) limit the blast radius of poorly architected fixes.
**Status:** Research and design input. No workflow, ruleset, setting, label, npm tag or GitHub state was changed. Nothing here is enabled.
**Follows:** [merge-queue-on-next-rollout.md](merge-queue-on-next-rollout.md) and [time-boxed-bugfix-train.md](time-boxed-bugfix-train.md), "Maintainer decisions (2026-10-21)": merge queue on `next` with `SQUASH`, per-fix review, self-test report; the train is deferred.
**Reading time:** ~20 min. Sections 1, 2.4 and 7 are enough for a go/no-go.

## Maintainer decision (2026-10-21)

- **Decision 2: yes.** The Windows and macOS matrix leaves the per-PR run. Principle, in the maintainer's words: use the lowest-cost checks to aggregate changes onto one branch, then run the full test on that branch.
- **Consequence for the queue plan:** a `merge_group` entry is the aggregation point. With `max_entries_to_merge: 1` it runs the full matrix once per PR, which only moves the cost. To get "full test once per aggregate", the queue batch size has to be above 1, or the deferred train comes back. See the open question in the hand-off message; the answer changes `merge-queue-on-next-rollout.md` §6 note 2.
- Decisions 1, 3 and 4 are still open.

---

Source labels: **[M]** measured in this repo (command given), **[D]** GitHub/npm docs (fetched 2026-10-21), **[X]** another project's own docs, **[R]** recommendation. **UNVERIFIED** marks anything I could not confirm from a primary source.

---

## 1. TL;DR

1. **Is "`main` = released, `next` = integration" a best practice? No, not as a second long-lived *integration-style* branch.** It is the shape nvie's GitFlow prescribes (`master` = production, every merge tagged; `develop` = integration) [X: https://nvie.com/posts/a-successful-git-branching-model/], and nvie's own 2020 note says that for continuously delivered software "a much simpler workflow" such as GitHub flow is better. This repo ships a minor release every 4 to 12 days (1.10.0 to 1.18.0, 2026-08-08 to 2026-10-19) [M], which is continuous delivery in practice.
2. **But `main` is not what costs you.** Everything attributable to `main` and release branches is **2,020 of 220,238 runner-minutes (0.9%)** in the last 30 days [M §2.3]. Retiring `main` would not move goal (1) at all, and it does nothing for goal (2): users get code through npm `latest`, not through the git `main` branch.
3. **The real problems are elsewhere:** (a) PR-event runs on the Windows/macOS conformance lanes are **46% of all runner-minutes**, yet in this window **0 of 225 failed PR `Tests` runs failed only on Windows or macOS** [M §2.3]; (b) a merge queue adds one full-matrix run per landing, because `test.yml` sets `full_matrix=true` for every event that is not `pull_request`, including `merge_group` [M §2.5]; (c) `main`'s own protection is a fiction (force-push allowed, no reviews, no checks) [M §2.1].
4. **Recommendation on `main`: REFRAME, do not retire, and do it last.** Keep the name and the meaning ("what is released"), change the mechanism: `main` becomes a **release-owned pointer** that the release workflow moves to the tagged release commit after `Verify publish`. No PRs into `main`, no `-s ours` back-merge, no "`main` is an ancestor of `next`" invariant. What the back-merge actually carries (rendered `CHANGELOG.md`, consumed `.changeset` fragments, version) goes to `next` as an ordinary squash PR through the queue. This removes the blocker named in merge-queue-on-next-rollout.md §4 without needing a ruleset bypass for a merge commit.
5. **Do first (this week, no migration):** fix the cost levers on the PR path (§4): run the Windows/macOS conformance lanes in `merge_group` and not on every PR push, and decide what to do with the `push` to `next` run once the queue has tested the same commit. Estimated effect: **220k to about 116k runner-minutes per 30 days (-47%)**, arithmetic in §4.2. These are estimates; the repo is public, so the billed amount is $0 today (§2.2).
6. **Blast radius needs structural levers, not a branch rename (§5):** a split `CODEOWNERS` with required code-owner review on the installer/hooks/workflow/release paths, a non-bypassable ruleset, and a working staged-rollout path. The npm `next` dist-tag is **stuck at `1.7.0-rc.6`** (July) and no RC has been cut since 1.7.0 [M], so the only soak stage in the model has been abandoned. Every release goes straight to `latest`.
7. **Decisions for the maintainer (<= 4) are in §9.**

---

## 2. Evidence

Repo `open-gsd/gsd-core`, **public**, default branch `next`. Window: **2026-09-21T00:08:56Z to 2026-10-21T18:18:35Z** (30 days) unless stated.

### 2.1 What `main` is used for today [M]

| Fact | Source |
|---|---|
| `main` moves only when a release PR merges. 4 release→`main` PRs merged in the window (#5018 1.15.0, #5222 1.16.0, #5429 1.17.0, #5532 1.18.0). No other PR targeted `main`. | `gh pr list --search created:... --json baseRefName`; `git log origin/main --first-parent --since=2026-09-21` |
| `main` is an ancestor of `next`; `next` is 35 commits ahead of `main`; 267 files differ. | `git rev-list --count origin/main..origin/next`; `git merge-base --is-ancestor origin/main origin/next`; `git diff --stat origin/main origin/next` |
| Releases are almost all minors. Tags: 1.10.0 (08-08), 1.11.0 (08-19), 1.12.0 (08-30), 1.13.0 (09-06), 1.14.0 (09-14), 1.15.0 (09-26), 1.16.0 (10-05), 1.17.0 (10-14), 1.18.0 (10-19). One patch (1.9.1) since July. | `git for-each-ref --sort=-creatordate refs/tags` |
| No pre-release since 1.7.0. npm dist-tags: `{ next: '1.7.0-rc.6', latest: '1.18.0' }`. | `git tag -l '*-rc*'`; `npm view @opengsd/gsd-core dist-tags` |
| Release flow: `release.yml` `create` cuts `release/X.Y.0` **from `next`** and bumps the version; `finalize` runs `install-smoke`, three test shards, a coverage gate, promotes `CHANGELOG`, tags `vX.Y.Z` on the release branch, `npm publish --provenance` to `latest` (environment `npm-publish`), creates the GitHub Release, runs `Verify publish`, then opens and `--admin --merge`s the release→`main` PR, then runs `sync-next-version.cjs`. | `.github/workflows/release.yml` lines ~140-175 (create), ~560-990 (finalize) |
| Hotfix: `hotfix/X.Y.Z` is cut from the prior stable tag, then `fix:`/`chore:` commits from `origin/next` are cherry-picked by `git cherry` (fallback source `origin/main`). `rc` is rejected for hotfixes, so a hotfix has no soak stage. | `release.yml` lines 48-60, 177-215 |
| Back-merge: `auto-backmerge.yml` fires on every push to `main`, builds `chore/backmerge-main-to-next-<sha>` with `git merge -s ours --no-commit --no-ff origin/main`, overlays `main`'s `CHANGELOG.md` and the `.changeset` deletions, runs a safety net for main-only changes, syncs the version, opens a PR, and `gh pr merge --admin --merge`s it. Stated purpose: "so `main` becomes an ancestor of `next`", "the invariant that keeps the next `release → main` merge clean". | `.github/workflows/auto-backmerge.yml` lines 3-20, 80-110, 151-161, 244-253 |
| `main` is also used by: `version-gate.yml` (`canary-version-leak` job on PRs into `main`), `pr-target-policy.cjs` (the five head-branch patterns allowed to target `main`), and `push: [main]` triggers in `test.yml` and `install-smoke.yml`. | those files |
| Live protection of `main` (classic): `required_signatures: true`, **`allow_force_pushes: true`**, `enforce_admins: false`, no required reviews, no required checks, no linear history. The three rulesets are all `enforcement: evaluate`; `gh api repos/open-gsd/gsd-core/rules/branches/main` and `.../next` return no active rules. `main-protection` targets `~DEFAULT_BRANCH`, which is `next`, not `main`. | `gh api repos/$R/branches/main/protection`; `gh api repos/$R/rulesets`; `gh api repos/$R/rules/branches/next` |
| ADR-230 already records this gap ("there is no CI gate on `main` at all"), and that its stated motive was the rebase treadmill, which ADR-415 then partly reversed by setting `strict: true` on `next`. | `docs/adr/230-introduce-next-integration-branch.md` (status block) |
| `next` (classic): `strict: true`, 1 approving review, `require_code_owner_reviews: false`, 7 required contexts. | `gh api repos/$R/branches/next/protection` |
| `CODEOWNERS` is one wildcard line, advisory by its own header. | `.github/CODEOWNERS` |

### 2.2 Is Actions spend real money here? [M][D]

- `gh api repos/open-gsd/gsd-core --jq .private` is `false`: **public repository**. "The use of standard GitHub-hosted runners is free: In public repositories." [D: https://docs.github.com/en/billing/concepts/product-billing/github-actions, fetched 2026-10-21]. The org is on the Team plan (3 seats) [M: `gh api orgs/open-gsd --jq .plan`]; Team includes 3,000 minutes a month for *private* repos [D same page].
- `gh api repos/$R/actions/workflows/test.yml/timing` returns `{"billable":{}}` [M]. **Billable minutes are not available for a public repo.** Everything below is *runner-minutes* computed from job `started_at` to `completed_at`, with a *list-price equivalent* for scale. It is not an invoice.
- Rates [D: https://docs.github.com/en/billing/reference/actions-runner-pricing, fetched 2026-10-21]: Linux 2-core $0.006/min, Windows 2-core $0.010/min, macOS 3/4-core $0.062/min. The current billing pages publish per-minute rates, not "1x / 2x / 10x" multipliers; the ratios (Windows 1.67x, macOS 10.3x of Linux) are my arithmetic. The older multiplier wording is **UNVERIFIED** on the current pages.
- What does bite on a public repo: concurrency caps. Team plan: 60 concurrent jobs, **5 concurrent macOS jobs**; Free is 20 / 5 [D: https://docs.github.com/en/actions/reference/limits]. And developer wall-clock: median green PR `Tests` run 31.5 min, p90 65.4 min [M, train memo §2.2].
- So goal (1) means two things: (a) wall-clock and concurrency headroom today, and (b) the bill if the repo ever goes private or moves to larger runners (larger runners are billed even in public repos: "The larger runners are not free for public repositories" [D pricing page]).

### 2.3 Measured spend [M]

Commands (rerunnable; `$R=open-gsd/gsd-core`):

```bash
# all runs, paged in 12-hour windows so no window exceeds the 1000-result cap (31,811 unique runs):
gh api "repos/$R/actions/runs?created=<start>..<end>&per_page=100&page=N"
# jobs for Tests, Install Smoke, Mutation Testing, Security Scan (4,810 runs):
gh api "repos/$R/actions/runs/{id}/jobs?per_page=100"
# runner-minutes = sum(job.completed_at - job.started_at); OS from job.labels
# PR state for the branch mapping: gh pr list --state all --search "created:A..B" --limit 1000
```

Coverage and limits of the data:
- Run list: complete for 2026-09-21 to 2026-10-21 (every 12-hour window returned fewer than 1000 results, so the cap was never hit).
- Job minutes: complete for `Tests`, `Install Smoke`, `Mutation Testing`, `Security Scan` except 26 runs (<1%) lost to API errors at the end of the fetch. **Not measured at job level:** the ~12 small policy workflows (`Docs Required`, `Changeset Required`, ...), `Release`, `CI timeout report`. The rate limit ran out before the sampled fetch of those. Wall-clock for `Release` was 329 min over 18 runs (`run_started_at` to `updated_at`), not comparable. The four measured workflows are the heavy ones; the rest are seconds-to-minutes per run (**UNVERIFIED** total).
- PR-to-run mapping is by head branch name against PRs created in the window (336 PRs: 220 merged, 76 open, 40 closed). It is approximate (reused branch names, forks, PRs created before 09-21), so the "merged / open / closed" split is indicative only.

**Totals, the four heavy workflows:** 220,238 runner-minutes = Linux 95,405 + Windows 96,672 (43.9%) + macOS 28,162 (12.8%). List-price equivalent $3,285 (Linux $572, Windows $967, macOS $1,746), of which Windows plus macOS is 83%.

| By workflow | Runs with jobs | Runner-min |
|---|---|---|
| `Tests` | 1,824 (1,531 PR, 231 push `next`) | Linux 89,261; Windows 96,672; macOS 27,956 = 213,889 |
| `Mutation Testing` (PR) | 934 | 3,010 (avg 3.3/run) |
| `Install Smoke` | 1,000 | 1,729 (avg 1.8/PR run) |
| `Security Scan` (PR) | 1,078 | 1,610 (avg 1.5/run) |

| By event / branch class | Runs | Runner-min | Share |
|---|---|---|---|
| PR, branch later merged | 2,077 | 78,945 | 35.8% |
| PR, branch still open | 1,774 | 73,652 | 33.4% |
| PR, closed without merge | 338 | 12,538 | 5.7% |
| PR, unmapped | 338 | 16,453 | 7.5% |
| **push to `next`** (`Tests` only) | 231 | 36,459 | 16.6% |
| **push to `main`** (`Tests` + `Install Smoke`) | 8 | 652 | 0.3% |
| push to `release/**`, `hotfix/**` | 4 | 324 | 0.1% |
| PRs from `release/*` and `chore/backmerge-*` | 39 | 1,044 | 0.5% |
| manual dispatch | 1 | 172 | 0.1% |

- **`main` and release plumbing = 652 + 324 + 1,044 = 2,020 runner-min = 0.9%.** Add `Release` workflow runs (not job-measured) and it is still small. Four release cycles produced 4 `main` pushes, 4 back-merge runs and 4 release PRs.
- By run conclusion: success 173,443 (78.8%), failure 35,049 (15.9%), cancelled 11,745 (5.3%). Superseded (cancelled) runs are 304 of 1,727 PR `Tests` runs (17.6%) but a small share of minutes because `cancel-in-progress: true` kills them early.
- **Per-run averages:** PR `Tests` run 115.2 runner-min; `next` push `Tests` run 157.8 runner-min. 322 head branches produced 1,727 PR `Tests` runs: 5.4 runs per branch.
- PR-event `Tests` minutes: Linux 74,857; Windows 78,674; macOS 22,769 = 176,300 (80% of the total). **1,245 of 1,531 PR `Tests` runs (81.3%) executed a Windows/macOS conformance job.** The "full matrix" is the common case for PRs, not an exception.
- **Failure shape (PR `Tests`, concluded `failure`: 225 runs):** 90 failed on Linux only, 135 on Linux plus Windows/macOS, **0 on Windows/macOS only**. Push to `next` (12 failures): 2 Linux only, 10 Linux plus others, 0 Windows/macOS only. Caveat: in September a macOS-only regression slipped through when the lanes were suppressed (#4421, quoted in `scripts/ci-test-scope.cjs`), so these lanes have caught real bugs in a different window.
- 139 PR `Tests` runs ended `action_required` (fork approval). They have no jobs and cost nothing.

### 2.4 Measured blast radius [M]

| What | Value | Source |
|---|---|---|
| Reverts on `next` in 30 days | 1 of 255 first-parent commits (a CI-tooling change, not a fix) | train memo §2.2 (not re-run) |
| Fix-forward frequency | **UNVERIFIED.** My re-count of `fix:` subjects and follow-ups was blocked by a local hook (`measure-dont-infer-guard`, a text-count guard) and I did not route around it. The train memo also found no reliable commit-message signal. | |
| `next` push `Tests` red | 12 of 231 (5.2%); 12 separate episodes | train memo §2.2; matches my 12 failures |
| September audit (#4990) | 26 of 300 `next` push runs red; 24 of 120 merges landed BEHIND via admin merge; #4540 and #4549 each green, combined tree red (`SIZE: workflow tier hard caps`, all three OSes) | `gh issue view 4990 -R open-gsd/gsd-core` |
| Typical fix PR | median 5 files, 199 changed lines, 7.0 commits | train memo §2.2 |
| Structural limits on a fix's reach | **None.** No PR size cap (the `*-size*` tests guard workflow and agent file sizes, not PR diffs). `CODEOWNERS` is one advisory wildcard. `require_code_owner_reviews: false`. No active ruleset. No path-based label routing. | `ls .github/workflows`; `git ls-files tests`; `.github/CODEOWNERS`; protection JSON |
| Staged rollout | Dead: `next` dist-tag at 1.7.0-rc.6; no `-rc` tag since 1.7.0; each recent release's three `Release` dispatches fall within the same day (e.g. 1.15.0: 2026-09-26, 14:34Z to 20:49Z, tag at 21:08Z) | `npm view`; `git tag -l '*-rc*'`; `Release` runs in the run list |

### 2.5 A correction to merge-queue-on-next-rollout.md §5

That memo says `ci-test-scope.cjs` "sets `full_matrix=true` only on push" and treats the queue's matrix as an open choice. The actual rule is in `test.yml` `changes` job: `if [ "$EVENT_NAME" != "pull_request" ]` then `code_changed=true`, `full_matrix=true` (lines ~136-146). **`merge_group` is not `pull_request`, so a queue entry runs the full Windows + macOS matrix by default.** The decision there is not "which matrix", it is "do we pay for the full matrix twice per landing" (§4.2).

---

## 3. Options

Criteria: (1) Actions cost, (2) blast radius, (3) merge-queue plan, (4) back-merge workflow, (5) migration cost/risk here, (6) who else uses it.

| # | Option | (1) Cost | (2) Blast radius | (3) Queue | (4) Back-merge | (5) Migration | (6) Used by |
|---|---|---|---|---|---|---|---|
| A | **Current**: `main` = released, `next` = integration, `release/*`, `hotfix/*`, back-merge | `main` plumbing 0.9% [M]; no lever either way | `main` gives no user-facing protection; protection on `main` is nominal [M §2.1] | Blocked until the `-s ours` merge commit is reconciled with `SQUASH` (rollout memo §4); needs a bypass actor | Required; pinned by `release-backmerge-invariants.test.cjs` | none | nvie GitFlow [X: https://nvie.com/posts/a-successful-git-branching-model/]; the author later advises simpler flow for continuous delivery |
| B | **Trunk-based**, `next` (or renamed `main`) the only branch; releases cut by tag or short-lived release branch from trunk; no second long-lived branch | Same as A plus ~0.3% saved on `push: main` runs | Same; the levers in §5 do the work | Clean: one branch, one method | Deleted | Medium-high: delete `auto-backmerge.yml`, rewrite release-finalize, `pr-target-policy`, 4 test files, docs. A rename `next`→`main` also touches hooks, skills, ADRs (`origin/next` is hard-coded in `.claude/hooks/pre-pr-gate.sh`, train memo §4.5) and collides in meaning with the npm `next` dist-tag | GitHub's flow: branch from default, PR, merge; no release branches in the flow [D: https://docs.github.com/en/get-started/using-github/github-flow]; Node.js `main` is the source of all release lines [X: https://github.com/nodejs/Release/blob/main/README.md]; Chromium fixes land on trunk first, then merge to branches [X: https://www.chromium.org/developers/how-tos/get-the-code/working-with-release-branches/] |
| C | **GitHub flow + dist-tags**: default branch deploy-ready, channels as npm dist-tags (`latest`, `next`, `canary`), no channel branches | Adds a small canary publish job per merge (a Linux publish, ~2 min est., UNVERIFIED) | Best of the options for goal (2): a bad fix reaches canary users first; promotion is `npm dist-tag add` [D: https://docs.npmjs.com/cli/v11/commands/npm-dist-tag] | Clean | Deleted | Medium: needs a canary publish path and a promotion step; whether `dist-tag add` works under the OIDC trusted publishing this repo uses is **UNVERIFIED** | npm's own convention: `latest` default, `next` "some projects use it" [D npm-dist-tag]; GitHub flow says nothing about deployment before merge on the page I read [D] |
| D | **GitFlow as published** (develop/master/release/hotfix, `--no-ff` merges everywhere) | Neutral | Neutral | Conflicts: GitFlow wants merge commits; the repo squashes | Required, plus merges to both branches | Already ~80% of this | nvie; and nvie's 2020 note says it fits "explicitly versioned" software or multiple versions in the wild, not continuous delivery [X same page] |
| E | **Release branches only when needed**, cut from trunk, fixes land on trunk first and are cherry-picked | Release branches only cost when active | Strong for patch lines: the cherry-pick is a deliberate act | Clean | Deleted; release-sync PR instead | Low-medium: this repo already cuts `release/X.Y.0` from `next` and cherry-picks hotfixes from `next` | Kubernetes: patch releases are cherry-picks into the release branch, monthly, with a cherry-pick deadline [X: https://kubernetes.io/releases/patch-releases/]; Rust: `beta`/`stable` forked from the default branch, promoted weekly [X: https://forge.rust-lang.org/release/process.html]; Node: `vX.x-staging` and `vX.x` only for release lines, commits land there only when a release is being prepared [X: Release README]; Chromium [X above] |
| F | **`main` as a release-owned pointer** (the user's "main = released" semantics, mechanism changed). Release workflow moves `main` to the tag commit after `Verify publish`; nobody opens PRs into it; release-sync PR carries CHANGELOG/changesets/version to `next` as a squash PR | -0.3% (drop `push: main` runs) | Neutral by itself; adds a protected, tamper-evident "what is released" ref (needs a ruleset that only the release app can update) | **Clean.** No merge commit, so `SQUASH` is the one method | Replaced by the release-sync PR; the ancestor invariant is dropped | Low-medium: one workflow rewritten, one deleted, four tests rewritten, §6 | Closest analogues: Rust's `stable` branch is a promoted ref, not an integration branch [X: Rust release process]; Node's `vX.x` is touched only at release time [X: Release README] |
| G | **Tags + GitHub Releases + immutable releases** as the "released" marker, no `main` at all | -0.3% | Adds supply-chain integrity: an immutable release locks assets and tag, and the tag cannot be moved or reused [D: https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases] | Clean | Deleted | Low if used as the *complement* to F; "retire `main`" is a later, optional step | GitHub immutable releases [D]. `tag-immutability` ruleset already drafted in this repo (in `evaluate`) |

Not a standalone option but a reference: Rust batches low-risk PRs into rollups because CI "scales poorly" with PR volume [X: https://forge.rust-lang.org/release/rollups.html, as cited in the train memo]. The merge queue's `max_entries_to_merge` is the GitHub analogue.

**Reading.** B, C, E and F are all compatible with the decided queue. They differ in how much of the release machinery they rewrite. F is the smallest change that keeps the maintainer's mental model ("`main` is what is released") and removes the one structural defect (the back-merge invariant). C is the strongest blast-radius lever and is independent of the branch question: it can ship with A, B or F.

---

## 4. Actions-cost levers

Every lever below cites the doc for the mechanism. Savings are **estimates from §2.3**, arithmetic shown, labelled [R].

### 4.1 Lever table

| Lever | Mechanism and doc | Status in repo | Gotcha |
|---|---|---|---|
| Path filters / `paths-ignore` | A workflow skipped by a path filter leaves its required checks "Pending" and blocks merge [D: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax]. `paths-ignore` skips only when every changed path matches. | Done correctly: `test.yml` always runs and a `changes` job classifies; `Required tests` is one aggregate. `Install Smoke`, `Mutation`, `Security Scan` use workflow-level `paths:` but are not required contexts. | Never put a required context behind a workflow-level path filter. Already respected. |
| Concurrency + `cancel-in-progress` | At most one running job per group; a new pending run replaces the old pending run; `cancel-in-progress: true` cancels the running one [D: https://docs.github.com/en/actions/using-jobs/using-concurrency]. | On: `test.yml` group is `${{ github.workflow }}-${{ github.head_ref \|\| github.run_id }}`. 17.6% of PR `Tests` runs were superseded [M]. | `merge_group` and `push` have no `head_ref`, so the group falls back to the unique `run_id`: queue runs never cancel each other (good). Do not change the group to `github.ref`, which would let one queue entry cancel another and ship a false red. |
| Skip duplicate push vs PR runs | `pull_request` and `push` are separate events [D: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows]. | `Tests` runs on PR, then again on `push` to `next` (231 runs, 16.6% of minutes [M]). | `Base branch health` (`scripts/ci-next-health.cjs`) and `publish-emitted-baseline` read the last push run on `next`. They need a replacement signal before the push run is dropped (§4.2). **UNVERIFIED** what the health check does with no recent push run. |
| Full OS matrix only at `merge_group` / pre-release | `merge_group` is a distinct event, a workflow must handle it or required checks never report [D: managing-a-merge-queue page]. | The classifier sets `full_matrix=true` for every non-PR event, and for 81.3% of PRs anyway [M]. | The scope classifier is reachability-based and fail-safe to full. Narrowing PRs to Linux needs an explicit "PR = scoped" switch, with a `full-matrix` label escape for PRs that touch installer/hooks/workflows. |
| Caching | `actions/cache` (already used for the emitted baseline). | Partial. | Not measured; **UNVERIFIED** gain. |
| `workflow_run` vs reusable workflows | `workflow_run` only fires if the workflow file exists on the default branch and chains at most three levels [D: events page]. Reusable workflows run inline in the caller's run. | `install-smoke` is called from `release.yml`; `PR mergeability` preflight is reusable. | Do not move required checks onto `workflow_run`: it reports on the default-branch file and does not attach to the PR head. |
| Larger vs standard runners | Larger runners are billed even in public repos [D pricing page]. | Standard only. | Sharding Windows `3/3` already cuts wall-clock; do not buy larger runners until the repo is private. |
| Scheduled jobs on the default branch only | "Scheduled workflows run on the latest commit on the default branch" [D events page]. | `Dismiss Unauthorized PR Approvals` runs on a schedule (2,078 runs, ~1.46k wall-min), `CI timeout report` daily. | Already default-branch only. Note: if `next` stays the default, nothing moves. If the default ever became `main`, every `schedule` workflow would silently run the older `main` copy. This is a reason to keep `next` as default (§6). |
| Merge-queue run counts | One `merge_group` run per queue entry [D: managing-a-merge-queue], plus the PR run. | See §4.2. | Entries rebuilt after an ejection run again. Ejection rate is unknown until the queue is live. |
| Draft / idle PR gating | Skip heavy lanes while a PR is draft. | Draft PRs are auto-closed by `close-draft-prs.yml`. | 76 open PRs hold 33.4% of minutes [M]. Not all are drafts; the lever is "run the matrix only on ready PRs", measured gain **UNVERIFIED**. |

### 4.2 Estimate: what the queue does to the bill, and what removes it

All numbers are runner-minutes per 30 days from §2.3.

| Scenario | Arithmetic | Result |
|---|---|---|
| 0. Today | measured | **220,238** |
| 1. Add the queue, change nothing | +216 landings x 157.8 min (a full run on the merge-group commit, same as a `next` push run) = +34,085 | **254,323 (+15.5%)** |
| 2. Scenario 1, and drop the `push` to `next` run (the queue just tested that exact commit) | 254,323 - 36,459 | **217,864 (-1.1% vs today)** |
| 3. Scenario 2, and PRs run Linux only, full matrix at `merge_group` | 217,864 - (78,674 Windows + 22,769 macOS PR minutes = 101,443) | **116,421 (-47.1% vs today)** |
| 3b. List-price equivalent of the PR-side Windows/macOS minutes removed | 78,674 x $0.010 + 22,769 x $0.062 = $787 + $1,412 | **$2,199 of $3,285 (67%)** |

Caveats, all [R]:
- Scenario 3 moves the Windows/macOS signal from "on every PR push" (5.4 runs per branch) to "once per landing". It does not remove it. The 0 of 225 figure (§2.3) says the lanes were never the sole signal in this window; #4421 says they were in September. Keep them at `merge_group` as the backstop.
- Scenario 3 raises the cost of a Windows-only failure: the PR is ejected from the queue instead of failing early. In this window that would have been 0 PRs; keep the `full-matrix` label so a PR that touches platform seams still gets the lanes up front.
- Ejections and queue rebuilds are not modeled (no data until the queue exists). Treat 116k as a floor for the saving to be re-measured after 4 weeks.
- The repo is public: billed cost is $0 in every row. The benefit is wall-clock, concurrency headroom (5 macOS jobs on Team [D]) and a smaller bill if the repo or runner type changes.

---

## 5. Blast-radius levers

| Lever | Mechanism and doc | Today [M] | Verdict [R] |
|---|---|---|---|
| CODEOWNERS + required code-owner review | Owners are requested automatically; required review needs the ruleset or protection to enable it, and the file must be on the base branch [D: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners, cited in the train memo]. | One wildcard, advisory, 4 listed users; `require_code_owner_reviews: false`. | **Do.** Split into paths: `bin/install.js`, `hooks/**`, `.github/workflows/**`, `.github/rulesets/**`, `scripts/release*`, `package.json`, `gsd-core/bin/**`. Require code-owner review on those only. With one active maintainer this is a speed bump, not a wall; it still blocks a non-owner author. |
| Size / diffstat cap and a "high-risk path" label | A workflow computes the diffstat and labels `risk:installer`, `risk:release`, `risk:workflow`, `size:L`; the label routes to CODEOWNERS and to the `full-matrix` lane. | No PR-size gate [M]. | **Do, advisory first** (a comment and a label, not a required check), then require for `size:L` after two weeks of data. Median fix is 5 files / 199 lines, so a cap near the p90 will bind rarely and bind on the right PRs. |
| Rulesets for protected paths | `file_path_restriction` ("Prevent commits that include changes in specified file and folder paths from being pushed") is a rule type with target `push` [D: https://docs.github.com/en/rest/repos/rules]. The "Restrict file paths" rule has a 200-entry, 200-char-per-entry limit [D: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets]. | No active rules. | **UNVERIFIED for this repo.** The rulesets docs describe push rulesets as blocking pushes to "a private or internal repository" [D: about-rulesets page]. The repo is public. Test in `evaluate` before relying on it; use CODEOWNERS as the primary control. |
| Staged rollout via dist-tags | `npm dist-tag add pkg@ver tag` points a tag at a version; `latest` is the default install; `next` is conventional but has no special meaning [D npm-dist-tag]. | Dead. `next` tag = 1.7.0-rc.6; every release goes to `latest` the same day [M]. | **Do, as the primary blast-radius lever.** Publish every release to `next` (or a `canary` tag), soak N days, then promote with `dist-tag add`. A hotfix that skips `rc` today is the highest-risk path; give it the same soak with a short window. **UNVERIFIED:** whether `dist-tag add` can run under the OIDC trusted-publishing identity `release.yml` uses (the Node 24 note in `release.yml` mentions trusted publishing for `publish` only). |
| Revert-friendliness | Squash = one commit per PR (decided). | Yes. | Keep. It is why `git revert <sha>` works as eject and rollback. |
| Required self-test report | Already planned. | | Keep; it is an effort gate, not a proof (train memo §6.4). |
| Mutation-testing scope | `mutation.yml` runs per changed covered module. | 934 PR runs, 3,010 runner-min (1.4%) [M]. | Cheap. Keep as is. |
| Automatic revert workflow when `next` goes red | A workflow opens a revert PR for the first red commit. | Not present. | **Defer.** With the queue, a merge lands only on a green merge-group commit, so red `next` becomes rare. The September reds had a cause the queue removes (merges while BEHIND, #4990). #4999 was reverted as "scope expansion beyond the request" (#5001); do not repeat it. Revisit if red `next` persists after 4 weeks of queue. |
| Post-merge canary soak window before `latest` | Same as the dist-tag row. | None. | Same row. |

**Where branch topology does and does not help blast radius.** None of the options in §3 limits a bad fix's reach by itself. What limits it is (1) who must review which paths, (2) whether the merge result was tested (the queue), and (3) how many users receive the build first (dist-tags). The `main` pointer (option F) adds one thing: a tamper-evident marker of what has been released, protected so only the release app can move it. Today `main` allows force-push [M].

---

## 6. Recommended design

**Keep:** `next` as the default branch, the sole integration branch and the sole PR target. Squash through the merge queue. `release/X.Y.0` and `hotfix/X.Y.Z` as short-lived release branches, cut from `next` and from the previous stable tag respectively. `release.yml`'s create / rc / finalize structure and all its pre-publish gates (`install-smoke-finalize`, `finalize-test`, coverage gate, `Dependency integrity gate`, `Verify publish`). `version-gate`'s canary-leak lint.

**Change:**

1. **`main` becomes a release-owned pointer.** It always equals the commit that carries the highest stable tag published to npm `latest`. Only the release workflow's app identity may update it, via a ruleset (`update` + `non_fast_forward` restriction with that one bypass actor). No PRs target `main`; `pr-target-validator` treats `main` as "blocked" for everything. [R]
2. **Replace the release→`main` PR and the `-s ours` back-merge** with: (a) a step after `Verify publish` that sets `main` to the tag commit (guard: only if this version is greater than the current `latest`, so a hotfix on an older line does not move `main` backwards); (b) a **release-sync PR into `next`** carrying exactly what the overlay carries today: the rendered `CHANGELOG.md`, the deleted `.changeset` fragments, the version sync. It goes through the queue as a normal squash PR. [R]
3. **Drop `push: [main]`** from `test.yml` and `install-smoke.yml` once `main` is a pointer, because `finalize` already runs both before publishing (saves 8 runs / 652 min per 30 days, 0.3%). Keep the canary-leak lint, but run it in the release workflow before the pointer moves.
4. **Cost:** PR-event `Tests` runs Linux scoped lanes only; `merge_group` runs the full matrix; decide the `push` to `next` fate per §4.2. Add a `full-matrix` label that forces the lanes on a PR. [R]
5. **Blast radius:** split `CODEOWNERS` and require code-owner review on the high-risk paths; advisory risk and size labels; revive the dist-tag soak (`next` or `canary` first, promote to `latest` after the soak). [R]

**What this rejects:** renaming `next` to `main` (option B). It buys nothing measurable, breaks `origin/next` references in hooks and skills, and makes `main` mean "integration" while the maintainer's vocabulary says "released". Retiring `main` outright (option G) is the cleanest end state and stays available after the pointer has run for a few releases.

### 6.1 What must be kept, and what each test pins

| Artifact | Pins (from the test source) | Under option F |
|---|---|---|
| `tests/release-backmerge-invariants.test.cjs` (#2504) | back-merge job exists; "Sync next's version" step is `continue-on-error`; `build:lib` prerequisite exists, is `continue-on-error`, runs before the sync; the ancestry steps (open PR + admin-merge) are present and not gated on a prior step outcome; the `-s ours` reconcile step is present; finalize timeout >= 30 min; finalize auto-merges the release→`main` PR; only when `MERGEABLE`; non-fatal; runs after `Verify publish` | Rewrite the five that name the merge-commit mechanism (ancestry steps, `-s ours`, release→`main` auto-merge, `MERGEABLE`). **Keep the intent of the others:** version-sync and build prerequisites are non-fatal, the sync happens after the publish is verified, finalize timeout >= 30 min. The core invariant becomes "the pointer moves only after `Verify publish`, and a failure to move it never fails a published release." |
| `tests/release-finalize-syncs-next-version.test.cjs` (#2423) | rc job wires `sync-next-version.cjs`; finalize calls it after publish; gated on `!inputs.dry_run` | Unchanged. |
| `tests/release-hotfix-empty-cherry-pick.test.cjs` (#2913) | empty-vs-conflict cherry-pick handling; `git cherry-pick --skip` | Unchanged (hotfixes still cherry-pick from `next`). |
| `tests/adr-230-pr-target-policy.test.cjs` + `scripts/pr-target-policy.cjs` | five head-branch patterns allowed to target `main` (`release/X.Y.0`, `hotfix/X.Y.Z`, `fix/critical-*`, `chore/backmerge-*`, `revert/critical-*`); behavior oracle; validator checks out base ref | Shrinks to "nothing may target `main`" in the same PR that moves the pointer. Not before. |
| `tests/canary-version-leak-lint.test.cjs`, `version-gate.yml` | `-canary.<N>` must not reach `main` | Move the lint to the release workflow step before the pointer moves. |
| `tests/issue-version-gate.test.cjs` | issue gate, no branch dependency | Unchanged. |
| `docs/branching.md`, `VERSIONING.md` | say `main` has "2 approvals ... signed commits", and `VERSIONING.md` shows `fix/*` merging to `main` | Both already disagree with reality [M §2.1]; correct them in the same change. |

---

## 7. Phased migration

Each phase is one scoped PR (the #4999/#5001 lesson), has a measure, and a rollback that is a revert.

| Phase | Change | Measure | Rollback / kill |
|---|---|---|---|
| 0. Baseline | Save §2 numbers and commands with the date range. Correct the §2.5 claim in the rollout memo. | numbers saved | none needed |
| 1. Queue wiring | As in rollout memo §8 Phase 1: `merge_group` trigger on the six metadata workflows. | all seven contexts report on a throwaway queue | revert the PR |
| 2. Cost, PR path | PR `Tests` runs scoped Linux only; `full-matrix` label forces the lanes; `merge_group` keeps the full matrix. Start in measurement mode: log what the PR would have skipped for two weeks (`Detect test scope` summary), then flip. | runner-min per 7 days vs 220k/30d baseline; count of Windows/macOS-only failures at `merge_group` | revert the single `test.yml` edit; kill if >= 3 Windows/macOS-only ejections in 4 weeks |
| 3. Queue on, `push` decision | Enable the queue (rollout memo Phases 2-3). Then drop or reduce the `push` to `next` `Tests` run, after replacing `Base branch health` and `publish-emitted-baseline` inputs. | baseline run; queue wait (kill: median > 2 h for two weeks, per the rollout memo) | re-add the `push` trigger |
| 4. Blast radius | Split `CODEOWNERS`; risk and size labels advisory; require code-owner review on high-risk paths. | PRs blocked by owner review; time to merge | remove the ruleset entry; labels are inert |
| 5. Stage rollout | Re-enable the `next`/`canary` dist-tag soak; promote via `dist-tag add`. Verify the OIDC question first on a throwaway package. | releases that soaked >= N days | publish straight to `latest` as today (`release.yml` revert) |
| 6. `main` pointer | Rewrite finalize to move `main` and open the release-sync PR; rewrite the five tests in §6.1; update `docs/branching.md` and `VERSIONING.md`; restrict updates on `main` to the release app; delete `auto-backmerge.yml`; shrink `pr-target-policy`. Dry-run first: `release.yml` has a `dry_run` input, so run `finalize` with `dry_run=true` and assert the pointer step would run. | one full release cycle; the pointer equals the `latest` tag commit; release-sync PR merges through the queue | restore the previous `release.yml` and `auto-backmerge.yml` from git. `main` is unchanged in shape (still has the old history), so the old flow resumes. Keep the old workflow files for one release. |
| 7. Optional | Retire `main` (option G) after >= 3 releases on the pointer. | | recreate the branch from the last tag |

Order matters: phases 1 to 5 deliver goals (1) and (2) and do not depend on the `main` decision. Phase 6 is last because it carries the most test churn and its benefit (removing the back-merge blocker) can be delivered sooner by the bypass-actor approach in rollout memo §4 Option A, if that proves workable.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Linux-only PR runs let a Windows/macOS regression reach the queue and eject an unrelated PR | `full-matrix` label for platform seams; keep the lanes at `merge_group`; monitor ejections; kill criterion in phase 2 |
| Dropping `push` to `next` removes the signal that `Base branch health` and the baseline cache use | Replace first (phase 3); **UNVERIFIED** the health check's no-data behavior |
| A pointer moved by a bot is a single point of trust | Ruleset allows only the release app; the pointer update is the last step after `Verify publish`; `tag-immutability` and immutable releases protect the tag it points at [D immutable-releases] |
| Hotfix on an older line moves `main` backwards | Guard in the pointer step: move only if the version exceeds the current `latest` |
| The release-sync PR is a PR into `next` and queue-bound; if CI is red `next`, the release metadata waits | It is data-only (CHANGELOG, fragments, version); a delay costs a stale `next` version, which the existing flow already treats as non-fatal |
| Re-doing back-merge work reads as scope expansion (#4999/#5001) | One PR per phase, each linking the maintainer's request; no merger workflow with a broad token |
| Plugin marketplace clients that follow the default branch get `next`, not released code | **UNVERIFIED.** `.claude-plugin/marketplace.json` uses `"source": "./"`; how a client resolves the ref was not checked. If it follows the default branch, the user-facing "released" ref is `next` today, and the `main` pointer (or a tag) is the only place to pin |

## 9. Decisions for the maintainer (<= 4)

1. **`main`: reframe to a release-owned pointer (recommended), keep as is, or retire?** Recommendation is reframe, in phase 6, after the cost and queue phases.
2. **Is the Windows/macOS matrix allowed to move from every PR push to `merge_group` only?** It is the single largest lever (-47% runner-minutes, §4.2) and rests on 0 of 225 Windows/macOS-only failures in 30 days.
3. **After the queue is live, drop the `push` to `next` full run?** Needs a replacement for `Base branch health` and `publish-emitted-baseline` first.
4. **Revive a dist-tag soak (`next`/`canary` -> `latest`)?** It is the only lever that limits how many users see a bad fix. It requires verifying that `dist-tag add` works with the current npm publishing identity.

## 10. UNVERIFIED items

- Whether a queue's bypass actor can skip the queue (rollout memo §2, still open).
- Availability of `file_path_restriction` push rulesets on a public repo.
- Whether `npm dist-tag add` works under OIDC trusted publishing.
- Whether the old "1x / 2x / 10x" multiplier wording still appears in current billing docs; current pages show per-minute rates.
- Job-level minutes for the ~12 small policy workflows and `Release`.
- Fix-forward frequency (count blocked by a local hook; not re-derived).
- Behavior of `Base branch health` when there is no recent `push` run.
- How Claude plugin marketplace clients resolve the ref for `source: "./"`.
- Gain from caching, and from gating heavy lanes on ready (non-draft) PRs.
- Chromium branch-cut timing (the page did not state it); Kubernetes branch names (the page did not state them).
