# Recovering from a red `next` under the merge queue — research memo

**Date:** 2026-10-27
**Trigger:** `next` push run 40515019525 (head `d90964063d`) went red on a Windows flake (#5498); the fix-forward PR #5755 could not enter the queue until an operator re-ran the red run, by accident of how the gate reads run status.
**Status:** Research input. No code, ruleset, label or workflow was changed. Nothing on GitHub was written.
**Reading time:** ~15 min

Source labels: **[R]** this repo (file:line), **[G]** `gh api` / `gh run` output taken 2026-10-27, **[D]** GitHub docs fetched 2026-10-27, **[X]** inference. **UNVERIFIED** marks anything I could not confirm from a primary source.

---

## 1. Summary and recommendation

- The deadlock is real and structural. The `Base branch health` job (`next-health`) fails every `merge_group` run while `next`'s latest completed push `Tests` run is non-success. Its only override, the `fix-next` label, is read from `github.event.pull_request.labels`, which is empty on `merge_group` [R scripts/ci-next-health.cjs:90-96, .github/workflows/test.yml:96]. The queue ruleset has no bypass actors and `current_user_can_bypass` is `never` [G], so a direct merge is impossible too (the 405 the orchestrator saw).
- The script comment says "land the fix-forward as a direct pull_request merge" [R :90-95]. That path no longer exists: the live `next-queue` ruleset is `active` [G]. The comment, `CONTRIBUTING.md:1317-1322` and `tests/ci-next-health.test.cjs:247` all describe a world without the queue.
- **#5755 got through only by accident.** `trek-e` re-ran the red run at 17:37:56Z (attempt 2). The PR was queued at 17:42:35Z; the gate job ran 17:42:57-17:43:02Z and printed `Base branch health: CLEAN` [G]. The script queries `status=completed&per_page=1` [R :204-205]; a run mid re-run is not "completed", so the query returned the previous green push run. That is an unintended bypass, and it also lets a second PR (#5750, queued 17:43:19Z) through.
- The gate is evaluated **once per workflow run**, in a ~5 s job at run start [G: job 122362080523 started 17:42:57, completed 17:43:02]. It is not re-read later. A merge_group run that started while `next` was red keeps its red `Required tests` result even if `next` goes green seconds later (and the reverse).
- **Recommendation (one change set, in this order):**
  1. **Make the label work on `merge_group`.** Parse `gh-readonly-queue/next/pr-<N>-<sha>` (visible as the run's `head_branch` [G]), resolve PR N, read its labels and who applied `fix-next` through the API, and honour the label only if the applier has write or admin permission on the repo. (Q1a.)
  2. **Treat a newer in-progress or queued push run as unresolved, not invisible.** Close the accidental bypass: the gate must not read a stale green run past a run that is still deciding. (Q1c.)
  3. **Run the gate script from `merge_group.base_sha`**, not from the merge-group commit. Today the checkout on `merge_group` is the PR-bearing queue commit [G: checkout log fetches `refs/remotes/origin/gh-readonly-queue/next/pr-5750-...`], so a queued PR can rewrite the gate it is judged by. (Q1a security.)
  4. Fix the docs and the stale test/comment text that promise a direct-merge path.
- Do **not** add an automatic retry-to-green or a flake quarantine to the gate (Q2). Repo policy forbids re-running red to green, and a recovery label is cheaper than a hidden retry.
- Do **not** raise the Windows timeouts as the cure for the incident (Q3). The 15 s default is below the repo's own 60 s npm bound, but the incident test was fixed by injecting its own bound (#5755), and raising defaults would mask the unexplained stalls in #5473.

---

## 2. Verified facts

| # | Claim | Source | Verified |
|---|---|---|---|
| 1 | Run 40515019525 is a `push` run on `next`, head `d90964063dda547f97b05f174158ca46ffc516f7`; attempt 1 failed 13:46:24Z-14:16:13Z; attempt 2 (triggered by `trek-e`) ran 17:37:56Z-18:07:15Z and succeeded | `gh api .../runs/40515019525/attempts/{1,2}` | Y |
| 2 | Attempt 1 failed only in `conformance test (windows-latest, 24, shard 1/3)`; `faulty-deps` test 2 `2. every exec* result carries timedOut` took `duration_ms: 15063.2776` | `gh run view 40515019525 --job 122226732014 --log` | Y |
| 3 | `execNpm` default timeout is `15_000`; `execTool` is `30_000`; `execGit` is `10_000` | `src/shell-command-projection.cts:708`, `:997`, `:696` | Y |
| 4 | The gate reads `.../actions/workflows/test.yml/runs?branch=<b>&event=push&status=completed&per_page=1` | `scripts/ci-next-health.cjs:204-205` | Y |
| 5 | Non-success of the newest completed run is RED; no completed runs is CLEAN; an API failure is INDETERMINATE and fails open | `scripts/ci-next-health.cjs:53-60, 78-83, 248-254` | Y |
| 6 | The override label is read from `PR_LABELS`, filled from `github.event.pull_request.labels`; on `merge_group` it is empty. The log shows `PR_LABELS:` blank | `test.yml:96`; `gh run view 40521973534 --job 122251190416 --log` | Y |
| 7 | `merge_group` runs of PR #5750 on base `d90964063d` failed at `Base branch health` twice (runs 40521973534 at 14:32Z, 40528006111 at 15:08Z) with the "last Tests run is red" error | `gh api .../runs/<id>/jobs` and job log | Y |
| 8 | #5755 carried `no-changelog` and `fix-next` (applied 16:32:34Z), was closed 16:42:05Z and reopened 16:42:10Z, was added to the queue 17:42:35Z, merged 18:12:37Z | `gh api repos/.../issues/5755/timeline` | Y |
| 9 | #5755 merge_group run 40553172526 started 17:42:53Z; its `Base branch health` job logged `Base branch health: CLEAN` at 17:43:01Z, five minutes into attempt 2 of the red run | job 122362080523 log | Y |
| 10 | Therefore the gate saw a different run than the red one because attempt 2 was in progress | consistent timeline (facts 1, 4, 9); I did not capture the API response at 17:43Z | **Partly.** Mechanism inferred from the `status=completed` filter. The list response during a re-run was not captured. UNVERIFIED |
| 11 | The prior completed push run then was 40474964784 (`aafb6131c5`, success) | `gh run list -w test.yml -b next -e push` | Y |
| 12 | Live ruleset `next-queue` (id 25600238) is `active`, `bypass_actors: []`, `current_user_can_bypass: "never"`, merge_method SQUASH, ALLGREEN, max_entries_to_merge 3, min 2, wait 15, timeout 90 | `gh api repos/open-gsd/gsd-core/rulesets/25600238` | Y |
| 13 | The committed file `.github/rulesets/next-queue.json` says `"enforcement": "disabled"` and `tests/next-queue-ruleset.test.cjs:32-34` forbids `active`. The live ruleset is `active`: repo file and live state disagree | file, `gh api` | Y |
| 14 | `docs/branch-protection.md:26-33` still calls the queue "evaluate" era and says "no bypass actors yet"; the live state is active | `docs/branch-protection.md` | Y |
| 15 | Classic protection on `next`: strict true, 7 required contexts (`check-branch`, `changeset-lint`, `docs-lint`, `validate-target`, `Issue link required`, `Pull request template format`, `Required tests`), `enforce_admins: false`, 0 required approvals, `required_linear_history: false` | `gh api repos/.../branches/next/protection` | Y |
| 16 | `Required tests` `needs` includes `next-health`, and exits 1 if its result is not `success`, before any scope logic | `test.yml:894-960` | Y |
| 17 | `next-health` has no `if:`; on `push` the script exits 0 immediately | `test.yml:56-66`; script `:70-72` | Y |
| 18 | On `merge_group` the script is checked out from the merge-group ref, not the base sha (`ref:` is `github.event.pull_request.base.sha`, empty for `merge_group`) | `test.yml:84`; checkout log of job 122251190416 | Y |
| 19 | `pull_request:` in `test.yml` has no `types:`, so a label added after `opened` does not re-trigger it; close/reopen emits `reopened` | `test.yml:9-11`; `test.yml:599-600` comment; fact 8 | Y (default event types are a GitHub doc fact I did not re-fetch: UNVERIFIED) |
| 20 | `gh pr create --label` missing the first `opened` run | orchestrator brief | **UNVERIFIED.** Mechanism (label set in a second API call after the event) not reproduced |
| 21 | Concurrency group is `${{ github.workflow }}-${{ github.head_ref \|\| github.run_id }}`, `cancel-in-progress: true`; for `merge_group` `head_ref` is empty so each run has its own group | `test.yml:25-27` | Y (that `head_ref` is empty on `merge_group` is [D] practice, not re-fetched: UNVERIFIED) |
| 22 | Push `Tests` on `next`, last 60 runs: 57 success, 3 failure; all 3 failures were Windows/macOS `conformance test` lanes (runs 40557814524, 40107893385, 40050931303) | `gh run list` + jobs API | Y |
| 23 | Run 40557814524 (head `0f5fa5cb8e`) failed on `conformance test (windows-latest, 24, shard 2/3)`: `review-lane-no-redirect-5433.test.cjs` test 1, `duration_ms: 15094`, a different test from #5498 | job 122378620808 log | Y |
| 24 | The same tree's `merge_group` run for #5750 (40553237320) was green (17:43-18:15Z) and then its push run 40557814524 was red | `gh run list -e merge_group`, fact 23 | Y (same-tree is inferred: SQUASH of a single-entry group. UNVERIFIED) |
| 25 | A 60 s npm bound is stated in `CONTEXT.md:1142` ("git 5-30s, npm 60s") and in the lint rule header `eslint-rules/require-subprocess-timeout.cjs:10-16` and message `:21-23`. The rule requires a `timeout` key only, not a value | files | Y (value not checked: I read the header, not the visitor) |
| 26 | Docs: a merge queue waits for required checks; workflows must trigger on `merge_group`; failure/conflict/timeout/user request removes a PR | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue | Y |
| 27 | Docs: that page says nothing about bypass actors or admins skipping the queue | same | Y (negative) |
| 28 | Docs: ruleset REST: `bypass_actors[].actor_type` in `Integration, OrganizationAdmin, RepositoryRole, Team, DeployKey, User`; `bypass_mode` in `always, pull_request, exempt`; `enforcement` in `disabled, active, evaluate` | https://docs.github.com/en/rest/repos/rules | Y |
| 29 | Docs: `merge_group` webhook has actions `checks_requested`, `destroyed`; the payload field list (`head_ref`, `base_sha`...) was not in the fetched part | https://docs.github.com/en/webhooks/webhook-events-and-payloads#merge_group | Partly. `base_ref` works in practice (`MERGE_GROUP_BASE_REF: refs/heads/next` in the log); `head_ref` and `base_sha` rely on the repo's own comment `test.yml:298-302`. UNVERIFIED in docs |
| 30 | Docs: a re-run keeps the original `GITHUB_SHA`/`GITHUB_REF`, runs as the original triggering actor's privileges, max 50 re-runs, 30 days | https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs | Y. The page does not say what the original run's `status` is during a re-run |
| 31 | A `merge_group` event has no label surface | brief + script comment; docs payload not confirmed | Y in practice (blank `PR_LABELS`); docs claim UNVERIFIED |
| 32 | Who may apply a label: `CONTRIBUTING.md:1319-1321` says "write access". GitHub's own minimum (triage) was not fetched | CONTRIBUTING | **UNVERIFIED** |

---

## 3. Current process

**Normal flow.** A PR is approved and green, `gh pr merge <n>` enqueues it (`gsd-merge-authority-guard.cjs` denies `--admin` when a queue exists [~/.claude/hooks/gsd-merge-authority-guard.cjs:276-280]). GitHub builds a `gh-readonly-queue/next/pr-N-<sha>` branch and fires `merge_group`. `test.yml` runs all required contexts, including `Base branch health`. On green the PR squashes into `next`, and `push` fires `Tests` on `next`.

**Gate.** `next-health` reads `next`'s newest completed push `Tests` run; RED fails the job, which fails `Required tests` for every PR and merge group, doc-only included [R test.yml:954-960].

**Documented recovery.** `CONTRIBUTING.md:1317-1322` and `scripts/ci-next-health.cjs:90-95`: a maintainer labels the fix PR `fix-next`; if the PR is in a queue, land it as a direct PR merge. The first half works only on `pull_request` runs. The second half is blocked by the active queue ruleset. `docs/branching.md` and `docs/branch-protection.md` contain no red-`next` runbook (searched for queue/bypass/admin/recover terms).

**What happened on 2026-10-27 (all [G]):**

| Time (Z) | Event |
|---|---|
| 13:46-14:16 | push run 40515019525 attempt 1 fails (Windows shard 1/3) |
| 14:31, 15:08 | PR #5750 queue runs fail at `Base branch health` |
| 16:32 | `fix-next` + `no-changelog` applied to #5755 |
| 16:42 | #5755 closed and reopened to refresh the `pull_request` run with the label |
| 17:37:56 | `trek-e` re-runs 40515019525 (attempt 2) |
| 17:42:35 | #5755 queued; merge_group run 40553172526 starts 17:42:53; gate reads CLEAN |
| 17:43:19 | #5750 queued; merge_group run 40553237320 passes |
| 18:07 | attempt 2 finishes green (flake) |
| 18:12:37 | #5755 merges; 18:12 push 40557814524 (head `0f5fa5cb8e`, #5750) starts and later fails on a different Windows test |
| 20:01 | `next` green again (run 40574393769, `3befe44bda`) |

Two things in that table are unplanned: the re-run happened to open the gate, and #5750 (not the fix) rode through behind it.

---

## 4. Recovery runbook (proposed)

### 4.1 Decision tree

```
next push Tests run is non-success
|
+-- Is the failure already understood and an issue exists?  (gh issue list --search "<test name>")
|     no  -> file/diagnose first (repo rule: never re-run to green). Then continue.
|
+-- Is a fix PR open?
|     no  -> open one (test-only if the product is not at fault). Continue at "fix queued".
|
+-- Is the fix PR in the queue? (gh pr view N --json mergeStateStatus,autoMergeRequest; timeline: added_to_merge_queue)
|     no, not mergeable yet -> get it green on pull_request runs (its own label fix-next gives BYPASSED there)
|     no, ready            -> enqueue it:  GSD_PR_GATES_OK=1 gh pr merge N   (only with fresh human authorization, see Q5)
|     yes                  -> what does the gate do for its merge_group run?
|
+-- Gate behaviour today (before the redesign)
|     merge_group + red next + no label surface  -> job fails, PR is ejected. DEADLOCK.
|     merge_group started while a re-run is in progress -> gate reads older green run. ACCIDENTAL PASS.
|
+-- Gate behaviour after the redesign (section 6)
|     merge_group + red next + fix-next on PR N by a write-permission actor -> BYPASSED (warning, job green)
|     merge_group + red next + no valid label                          -> RED (PR ejected, expected)
|     merge_group + newest push run in progress, previous red          -> RED (pending, do not read stale green)
|     merge_group + newest push run in progress, previous green        -> CLEAN with a notice
```

### 4.2 Steps today (the only path that exists on the current gate)

1. Identify the red run and the failing job. `gh run list -w test.yml -b next -e push -L 5 --json databaseId,status,conclusion,headSha` then `gh run view <id> --json jobs --jq '.jobs[]|select(.conclusion=="failure")|.name'`.
2. Read the failing log: `gh run view <id> --job <jobId> --log | grep -E "not ok|duration_ms|##\[error\]"`. Record the test name, duration and head sha on the issue.
3. Confirm the fix PR's scope. `gh pr view <N> --json files,labels,mergeStateStatus`.
4. Apply `fix-next` to the fix PR **only on explicit in-turn human instruction** (Q5). `gh pr edit <N> --add-label fix-next`. Then close and reopen (`gh pr close <N>`; `gh pr reopen <N>`), or push a commit, so the `pull_request` run sees the label (fact 19).
5. Enqueue: `GSD_PR_GATES_OK=1 gh pr merge <N>` (literal number, no `--admin`).
6. **Expect the queue run to fail** at `Base branch health`, because `merge_group` carries no label (fact 6). The only way through today is the unplanned one: the red run must be mid re-run (fact 9). That needs `gh run rerun <runId>`, which `block-ci-rerun-guard.cjs` denies unless the user asked for it in the last six user turns [~/.claude/hooks/block-ci-rerun-guard.cjs:16-40]. Treat this step as a human decision, not a routine.
7. Watch: `gh run list -w test.yml -e merge_group -L 3`; the PR timeline shows `added_to_merge_queue` / `removed_from_merge_queue`.
8. After the fix merges, confirm the next push run is green: `gh run list -w test.yml -b next -e push -L 3`.

### 4.3 Steps after the redesign

1. Steps 1-3 as above.
2. A maintainer applies `fix-next` to the fix PR (human-authorized). No close/reopen is needed for the queue, because the `merge_group` job reads labels from the API at run start.
3. `gh pr merge <N>`; the queue run's `Base branch health` job logs `BYPASSED` with the label applier and the red run URL.
4. The label is removed by the maintainer after merge (a follow-up workflow can strip it automatically on `closed`).
5. Verify with 4.2 step 8.

---

## 5. Answers to the five questions

### Q1. Redesign the gate so a red `next` cannot deadlock its own fix

**(a) Parse the queue branch, resolve PR N, read its labels. Feasible.**
- The merge-group run's `head_branch` is `gh-readonly-queue/next/pr-5755-d90964063dda...` [G]. Pattern: `^gh-readonly-queue/<base>/pr-(\d+)-[0-9a-f]{40}$`. In the workflow it is `github.event.merge_group.head_ref` (UNVERIFIED in docs; the exact name must be confirmed on a real run before relying on it, see section 8). `head_sha` is not needed.
- With `GITHUB_TOKEN` and `pull-requests: read` (the job now has `contents: read`, `actions: read` only [R test.yml:71-73]) call `GET /repos/{r}/issues/{N}/labels`. Grouped entries: one merge group can hold up to three PRs [G ruleset]. A group's branch names only one PR (the last), but the commit stack contains all three. Either read all PR numbers from the group's commits or accept that the label must be on every PR in the group; the safe default is "the label is honoured only when the group has exactly one entry or every entry that is not the fix is also labelled". Needs a decision (section 8).
- Cost: one extra API call, no new secret.
- Risk: label state at the time the job runs, not the time of enqueue. A label added after the run started changes nothing (single evaluation, fact 9). Good: it removes a TOCTOU race.

**(b) Skip/relax when the diff is test-only or touches only implicated files. Feasible but not sufficient alone.**
- Diff files are available (`GET /repos/{r}/pulls/{N}/files`). A path allowlist (`tests/**`) says nothing about whether the PR actually fixes the red test. A test-only PR that adds a new failing test, or deletes coverage, would pass. To be meaningful it must be compared with the failing test names from the red run's logs, which means parsing job logs of a run (large, Windows TAP). Fragile. Use as an *additional* filter on the label path, not as the primary: for example "the label is only honoured if the PR does not touch `.github/**`, `scripts/ci-*` or `.github/rulesets/**`".

**(c) Treat in-progress/re-run attempts as indeterminate. Required, but not by itself.**
- Today INDETERMINATE fails open [R :248-254]. If a mid-flight re-run were simply INDETERMINATE the accidental bypass would still pass the gate. So: query without `status=completed` (`per_page=5`, `event=push`), take the newest run by `created_at`. If it is `in_progress`/`queued`/`waiting`, return `PENDING` and decide from the newest *completed* run: previous red -> RED (a re-run in flight proves nothing yet), previous green -> CLEAN.
- Effect on the incident: attempt 2 in flight, previous completed run on this run id was attempt-1 red. But the API reports one run object with the latest attempt's state, not attempt 1's conclusion. So after the change the script sees run 40515019525 itself as in progress and falls back to the previous *distinct* run 40474964784 (green). **That is still CLEAN.** To close the hole the script must look at the run's attempt history (`GET .../runs/{id}/attempts/{n}`) and treat "latest attempt in flight, prior attempt failed" as RED. I verified both attempts are retrievable [G fact 1]. UNVERIFIED: what the list endpoint returns for `conclusion` while a re-run is running.
- Downside: a legitimate flake re-run keeps the queue closed until it finishes (~30 min). That is the correct trade: it forces the label path or waiting.

**(d) Ruleset bypass actors / temporary enforcement toggle.**
- API supports `bypass_actors` with `bypass_mode` `always` or `pull_request`, actor types incl. `User`, `Team`, `RepositoryRole`, `OrganizationAdmin`, `Integration` [D rest/repos/rules]. The docs do **not** say that a bypass actor can merge past a *merge queue* rule (queue page and ruleset page are silent) [D]. The rollout memo already marked this UNVERIFIED (`docs/research/merge-queue-on-next-rollout.md` §2). Untested here: I did not change the ruleset.
- A permanent bypass actor for human admins removes the structural deadlock but is exactly the `--admin` pattern the 2026-09-25 audit found abusive (`gsd-merge-authority-guard.cjs` header: admin merges past red checks and before checks started).
- Toggling `enforcement` to `disabled` for the duration is a repo-admin API write (`gh api -X PUT repos/.../rulesets/25600238`), switches off queueing for **all** PRs, and bypasses combined-tree testing. Keep as break-glass only, with a runbook line and a tracking issue. The matching hook `gsd-merge-authority-guard.cjs` and the repo's `enforce_admins=false` mean it needs a human.

**(e) Dedicated fix-forward workflow that confirms the diff covers the failing test.**
- Highest assurance, highest cost: a workflow on `pull_request` that (1) reads the red run's failing test names, (2) checks the PR touches/adds those tests, (3) applies a machine label. Needs log parsing and a label-write token (`pull-requests: write`, `issues: write`); a workflow that writes labels is a privilege-escalation surface (a forked PR can influence the diff it analyses). Defer.

**Recommendation: (a) + (c), with the base-sha script checkout (section 1 item 3) and the label-applier permission check.**

Security analysis of (a):
- *Who can apply labels?* `CONTRIBUTING.md:1319-1321` says write access; GitHub's actual minimum role for label changes (triage) is UNVERIFIED here. So a triage-role collaborator might be able to label. Mitigation: do not trust the label alone. Fetch `GET /repos/{r}/issues/{N}/events` (last `labeled` event for `fix-next`) and `GET /repos/{r}/collaborators/{actor}/permission`; honour only `admin` or `write` (or restrict to `.github/MAINTAINERS`, the file the repo already uses for the review check [R docs/branch-protection.md:63-98 / MAINTAINERS file]).
- *Can a contributor game it?* (1) A fork author cannot label. (2) A contributor could push a PR that edits `scripts/ci-next-health.cjs` or `test.yml`; on `merge_group` those files are read from the queue commit (fact 18), so the edited gate would judge itself. Fix: check out `merge_group.base_sha` for `scripts/` (the repo uses `github.event.merge_group.base_sha` already at `test.yml:302`). Note `test.yml` itself still comes from the queue commit; that is inherent to GitHub's `merge_group` and is only as safe as the review that precedes queue entry. (3) A labelled PR that is not a fix still passes the gate: the label overrides *one* check; the other six required contexts and the full matrix still run. The real exposure is landing a second, unrelated regression on red `next`; the label is per-PR and logged (`BYPASSED` summary), so mitigate with the narrowing in (b) and by removing the label after merge. (4) A label applied to an unrelated old PR in the same group (up to 3) would bypass the group; hence the "all entries" rule above.
- *Race:* label is read at run start; later removal does not retract a pass (acceptable; same as today's single evaluation).

### Q2. Should a flaky failure on `next` ever red the gate?

- Structure: `Required tests` aggregates `test`, `test-conformance` (Windows/macOS lanes, shard `1/3`..`3/3`), `test-inert`, `coverage-gate`, `qa-loop-walk` [R test.yml:894-960]. Required checks on the ruleset are the aggregate only (`docs/branch-protection.md` "do not add required checks for individual matrix jobs"). The Windows lanes run on the PR (full scope) and again on `merge_group`/`push`, so a lane that is flaky can fail the post-merge push even after the merge group passed (fact 24).
- Flake rate: 3 of the last 60 `next` push runs failed (5%), all in `conformance test` lanes, on three different tests [G fact 22-23]. Two of the three in the last 24 h were ~15 s timeouts on Windows.
- Option comparison:

| Option | Effect | Verdict |
|---|---|---|
| Keep gate red on any non-success push run | Matches #4422 intent (`ci-next-health.cjs:4-25`): a false negative is the worse error | Keep as default |
| Read the merge-group run's Required-tests result for the same tree and clear the gate if green | Cheap proof that the code is fine (the tree already passed). Tree equality for multi-entry SQUASH groups UNVERIFIED | Candidate for a *labelled-as-suspect* state, not a silent pass; maintainer decision |
| Retry threshold / `gh run rerun --failed` automatically | Hides flakes; contradicts "never re-run to green" (block-ci-rerun-guard.cjs, `bug-fixer.md:945` as cited in `docs/research/time-boxed-bugfix-train.md` §4.2) | Reject |
| Flake quarantine list | Needs an owner and expiry; tests are skipped without a diagnosis. Out of scope for the repo's rule | Reject for now |
| Cheaper recovery (label path, section 4.3) | Red stays visible, deadlock gone | **Recommend** |

- Conclusion: yes, a failure on `next` should still red the gate, because it is real evidence about a combined tree nobody has understood. What must change is that red must be *escapable by the fix* (Q1), not that flakes be ignored.

### Q3. Are `execNpm` 15 s and `execTool` 30 s too tight on Windows CI?

- Defaults: `execNpm` 15 s (`src/shell-command-projection.cts:708`), `execTool` 30 s (`:997`), `execGit` 10 s (`:696`).
- The repo's rule: "git 5-30s, npm 60s" in `CONTEXT.md:1142` (retired prose defect `DEFECT.UNBOUNDED-SUBPROCESS`) and the lint rule `eslint-rules/require-subprocess-timeout.cjs:10-16, 21-23`. The rule enforces presence of a `timeout` key, not its value (header read; visitor not checked). So `execNpm`'s 15 s is not a lint violation and is *below* the stated npm bound.
- Evidence of elapsed times on Windows (run logs 2026-10-27):
  - 15063 ms: `npm --version` (via `execNpm`) in `faulty-deps` test 2 (run 40515019525).
  - 15295 and 15431 ms: other tests in the same shard/lane (same log).
  - 15094 ms: `review-lane invoke` in `review-lane-no-redirect-5433.test.cjs` (run 40557814524), a different file.
  - Windows-only ~2-4 s `node.exe` spawns are common in `[seam-spawn]` lines (run 40557814524, shard 2/3). A 15 s outlier is 4-7x typical.
- Interpretation: these are clusters at about the bound, not a slow tail. `docs/research/windows-ci-child-process-stalls.md` (branch `docs/5473-windows-ci-stall-research`) documents that Node's timeout can fire when a descendant keeps a pipe open, and that "ETIMEDOUT at exactly the bound" does not prove the child was running. So raising the default may hide a stall, not fix slowness. Cause for #5473 is not established there.
- Recommendation: (1) tests must inject their own timeout (what #5755 did); (2) raise `execNpm`'s default to 60 s only as a separate, issue-backed change, because it is the repo's stated npm bound and production callers degrade on timeout anyway; (3) leave `execTool` at 30 s until an actual production caller is shown to exceed it; (4) note that `~/.claude/hooks/block-timeout-increase-guard.cjs` exists and will deny timeout-raising edits unless a human authorizes (content not read: UNVERIFIED).

### Q4. Orchestrating multi-PR takeovers

- `docs/issue-driven-orchestration.md` describes a single issue to PR loop and explicitly has no auto-merge or poller (Safety boundaries, Non-goals). It does not cover multi-PR takeovers, merge ordering, or enqueueing. No `CLAUDE.md` rule covers it either; the closest is the pipeline rule in agent memory (`feedback-never-end-turn-waiting.md`: green PRs do not auto-merge, trigger the merge yourself with a literal number) and the contract in `bug-fixer.md` (user-level command, not in this repo).
- What went wrong (from the brief; the PR set and the 8 h idle time were **not** re-verified here beyond the timeline in §3): six PRs on one roadmap code region conflicted pairwise (DIRTY after each landing); PRs sat CLEAN but un-queued because nothing owned the enqueue step. Epic #5692 (`gh issue view 5692`) confirms the code area: one owner for ROADMAP Progress table sites.
- Proposal:
  1. **Integration PR up front when PRs share a region.** Stack the takeover commits on one `fix/5692-integration` branch off `origin/next` in dependency order, one PR, one gsd-test pass, one review. Reasoning: the queue squashes each PR separately, so N overlapping PRs always yield N-1 rebases. Use serial resubmits only when the PRs touch disjoint files.
  2. **Orchestrator owns the enqueue step.** After a PR is green and approved, the orchestrator runs `gh pr merge <literal N>` itself, in the same turn, then records "queued at <time>" in the work journal. The queue (not authors) handles BEHIND.
  3. **Timer watchdog.** Every ~20 min the orchestrator lists PRs it owns: `gh pr list --author @me --json number,mergeStateStatus,autoMergeRequest,statusCheckRollup`; any PR that is `CLEAN` with no merge-queue entry for more than one cycle is enqueued or explained. (The 8 h idle is the failure to catch.) No daemon: a scheduled task or the `loop` skill, matching the "no poller in GSD" stance in `docs/issue-driven-orchestration.md`.
  4. **Bench assignment in worker briefs.** Name the Bench for each worker in its brief so concurrent `gsd-test` runs do not collide on one host (`gsd-test-single-flight-guard.sh` and `gsd-bench-pin-guard.sh` exist; `.claude/skills/bench-orphan-sweep` cleans leftovers). Whether the briefs currently carry a bench pin: UNVERIFIED.
  5. **Hand over the command, not a paraphrase** (`feedback-subagents-get-the-command-verbatim.md`).
  6. **Red `next` during a takeover:** pause enqueueing everything except the fix; run section 4. Do not stack a second PR in the queue behind a red `next` (the accidental bypass let #5750 through on 2026-10-27).

### Q5. Actions needing fresh explicit authorization, and how to encode them

| Action | Enforced today by | Encoding gap |
|---|---|---|
| `GSD_PR_GATES_OK=1` | `.claude/hooks/pre-pr-gate.sh:417-418` denies `gh pr create/edit/ready/merge` on own PRs unless the string appears in the command. `CLAUDE.md:11` forbids emitting it without an in-turn human instruction naming the token | The hook only greps the command string; it cannot tell whether a human authorized it. The "token" is self-issuable by the agent. Only policy text prevents misuse |
| `GSD_HUMAN_OVERRIDE=1` | `pre-pr-gate.sh:317` allows push when present; logs to `.gsd/override.log` (`pre-pr-gate.sh:20`); `CLAUDE.md:11` forbids agent use | Same: string match. Logged, not verified |
| `GSD_MERGE_GATE_OVERRIDE=1` | `~/.claude/hooks/gsd-merge-authority-guard.cjs:98` (also reads process env), logged | Same |
| `--admin` merges | `gsd-merge-authority-guard.cjs`: allowed only for author `trek-e`, PR not already approved, review missing; denied entirely when a merge queue is active (`:276-280`) | Good: live-state check, fails closed. Dead code for `next` now |
| `gh pr merge` / auto-merge | Same guard: live checks (draft, conflict, red) and fail-closed on variables (`feedback-never-end-turn-waiting.md`); `--disable-auto` parsed (`:206`) | Enabling auto-merge via other tools (`mcp__ccd_pr__set_auto_merge`) is not covered by the Bash hook; UNVERIFIED whether any matcher exists |
| `gh run rerun`, `gh workflow run`, empty commit | `~/.claude/hooks/block-ci-rerun-guard.cjs`: denied unless a genuine user message in the last 6 user turns asks for a rerun | Strong, transcript-based. Template for the others |
| Applying labels `fix-next`, `confirmed-bug`, `no-changelog` | **No hook found.** `grep` of hooks for `add-label` found only matches in unrelated files; `CLAUDE.md:137` only defines the label vocabulary | Gap. `fix-next` changes gate behaviour; `confirmed-bug` is the fix gate |
| `gh pr close` / `reopen` | **No hook found** | Gap. Close/reopen restarts CI and, in the 2026-10-27 timeline, was used as a label-refresh workaround |
| Memory feedback rules | `feedback-*` memory files (auto-memory) | Advisory only |

Proposed encoding changes:
1. **One transcript-based authorization hook** modelled on `block-ci-rerun-guard.cjs` (same `userRequestedRerun` scan of the last N genuine user turns), applied to: `gh pr edit --add-label fix-next|confirmed-bug`, `gh pr close`, `gh pr reopen`, `gh pr merge --auto`, `gh api .../rulesets` writes, and `GSD_PR_GATES_OK`/`GSD_HUMAN_OVERRIDE` strings. The agent-emitted token then needs a matching user message naming the token or the action.
2. **Move the token from the command string to a value only the human can supply** (as the hook text already says for `GSD_MEMTRACE_GUARD_OFF`: it must be exported in the shell that launches the agent). Do this for `GSD_HUMAN_OVERRIDE` and `GSD_MERGE_GATE_OVERRIDE`; keep `GSD_PR_GATES_OK` as a per-command marker only after the hook confirms `/code-review` and `/security-review` artifacts exist (`artifact-gates` skill pattern: gate on a file the step must produce).
3. **Server-side where possible.** A `fix-next` applied by a non-writer should be ignored by the workflow (Q1 permission check), so the label is safe even if an agent applies it.
4. **Write the rule down.** Add the table above to `CONTRIBUTING.md`'s base-health section and to `CLAUDE.md:11` as a list of actions that need an in-turn instruction: `fix-next`, `confirmed-bug`, close/reopen of an owned PR, enabling auto-merge, rerun, `--admin`, ruleset writes.

---

## 6. Implementation work list (issue-sized; items 1, 2, 3, 5, 7 implemented on this branch; 4, 6, 8-11 open)

| # | Type | Title | Files |
|---|---|---|---|
| 1 | Script | Gate: resolve the fix PR from `gh-readonly-queue/<base>/pr-<N>-<sha>`, read labels via API, verify the labeller's permission, return BYPASSED on `merge_group` | `scripts/ci-next-health.cjs` (`resolveNextHealth`, `main`; new `resolvePrFromQueueRef`, `fetchLabelsWithApplier`) |
| 2 | Script | Gate: do not hide an in-flight push run or re-run; read attempt history, new `PENDING` verdict; keep fail-open only for unavailable API | `scripts/ci-next-health.cjs` (`fetchLatestRun`, `classifyRunConclusion`) |
| 3 | Workflow | Pass `MERGE_GROUP_HEAD_REF`, add `pull-requests: read`, check out `scripts/` from `merge_group.base_sha` (not the queue commit) | `.github/workflows/test.yml` (job `next-health`, lines ~67-112) |
| 4 | Workflow | Strip `fix-next` after the fix merges (on `closed`/merged), or on a push run that goes green | new `.github/workflows/clear-fix-next.yml`, or an addition to an existing label workflow (check first) |
| 5 | Tests | Cover: queue-ref parser (valid, malformed, multi-digit PR), label+permission outcomes, re-run in flight, attempt-1-failed/attempt-2-running, no label, API errors | `tests/ci-next-health.test.cjs` (replace the `merge_group has no label surface` case at ~:247) |
| 6 | Ruleset test/config | Reconcile live (`active`) vs committed (`disabled`) `next-queue`; decide on a break-glass bypass actor; update the test that forbids `active` | `.github/rulesets/next-queue.json`, `tests/next-queue-ruleset.test.cjs:32-38`, `.github/rulesets/sync-rulesets.sh` |
| 7 | Docs | Add the red-`next` runbook (section 4.3); remove "direct pull_request merge" wording; update the queue section for `active` | `CONTRIBUTING.md` (~:1317-1322), `docs/branch-protection.md:26-54`, comment in `scripts/ci-next-health.cjs:90-95` |
| 8 | Docs | Add multi-PR takeover guidance (Q4) to the orchestration guide | `docs/issue-driven-orchestration.md` |
| 9 | Hooks (user-level) | Authorization-by-transcript hook for labels, close/reopen, auto-merge, ruleset writes | `~/.claude/hooks/` (new, modelled on `block-ci-rerun-guard.cjs`) and registration in `~/.claude/settings.json` |
| 10 | Product | `execNpm` default to 60 s, as its own issue with evidence; keep `execTool` | `src/shell-command-projection.cts:708` + tests |
| 11 | Research | Does a ruleset bypass actor skip a `merge_queue` rule? Test on a scratch repo | no repo file; update `docs/research/merge-queue-on-next-rollout.md` §2 |

---

## 7. What not to do

- Do not use `--admin` or `PUT /pulls/N/merge`: the queue ruleset returns 405 [brief; the live ruleset is active, fact 12], and `gsd-merge-authority-guard.cjs:276-280` denies `--admin` under a queue.
- Do not re-run a red `next` push run to open the gate. It worked once by accident; it also lets unrelated PRs through (#5750).
- Do not disable the ruleset as a routine; it stops combined-tree testing for every PR.

---

## 8. Open and UNVERIFIED items

1. Exact name and presence of `github.event.merge_group.head_ref` / `.head_sha` / `.base_sha` in the webhook payload: not in the fetched part of the docs. Confirm with a one-off `toJSON(github.event.merge_group)` step (not done here: read-only brief).
2. What `GET .../workflows/test.yml/runs?status=completed` returns for a run with an attempt in progress (fact 10). Capture it during the next re-run.
3. Group of 2-3 PRs: label rule semantics (every entry vs the last entry). Maintainer decision.
4. Whether a ruleset bypass actor can skip a `merge_queue` rule (docs silent). Test on a scratch repo.
5. GitHub's minimum role for label changes (triage vs write); `CONTRIBUTING.md:1319` says write.
6. `gh pr create --label` missing the first `opened` run (fact 20); my evidence is only the close/reopen on #5755.
7. Tree equality between a push run's head and the preceding `merge_group` head for SQUASH groups of more than one PR.
8. The six takeover PRs and the ~8 h idle gap were not reproduced from the API here; only #5755/#5750 timelines were.
9. Contents of `~/.claude/hooks/block-timeout-increase-guard.cjs`; whether any hook matches `mcp__ccd_pr__set_auto_merge`.
10. Whether bug-fixer / takeover worker briefs currently pin a Bench.
11. `eslint-rules/require-subprocess-timeout.cjs`: I read the header (lines 1-60); I did not confirm the visitor ignores the timeout value.
12. Root cause of the Windows ~15 s clusters is unexplained (see #5473 memo).
