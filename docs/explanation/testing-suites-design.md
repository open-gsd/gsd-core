# Why the test suites are guarded the way they are

> Explanation. The rules, commands and tables are in [Testing Suites](../TESTING-SUITES.md);
> this page records why each guard has the shape it has.

## Why regression tests are folded, not filed one per bug

`node --test` spawns one child process per FILE, so file count — not test
count — is the unit of CI overhead, and it is worst on Windows lanes where
every spawn is Defender-scanned. The 2026-06 CI audit found 244 one-off
`bug-*` files (~38% of the suite). That population is grandfathered in
`scripts/lint-regression-test-names.allowlist.json` and enforced by an
identity ratchet (`npm run lint:regression-names`, part of `npm run lint:ci`),
which also bans `fix-*` and `issue-*` NNNN-prefixed files the same way:

## Why a folded suite may appear only once per host

When a standalone file is folded into its owning module's test file, the moved
suite is wrapped in a self-contained block carrying a marker:

```javascript
// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-376-claude-js-hook-gsd-rewriter.test.cjs — …
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-376-claude-js-hook-gsd-rewriter (…)", () => { … });
}
```

Because the block is self-contained, a **second verbatim copy in the same host
parses, registers, and passes — twice.** Nothing in a green suite reports it.
[#3271](https://github.com/open-gsd/gsd-core/issues/3271) found 25 such copies
(~5,800 lines) across three install suites, all from a single stale-base
re-application during the consolidation epic. The cost is not only wasted CI on
every lane: it is a `DEFECT.GENERATIVE-FIX` trap, because a contributor fixing
one of those regressions edits the copy they found and leaves the other
asserting the old behavior, with the suite still green.

It keys on the whitespace-delimited token after `folded:`, which matters in both
directions. A narrower key that stops at `.` would collide
`feat-443-effort-fast-mode.integration` with `feat-443-effort-fast-mode` — two
genuinely distinct suites that coexist in `tests/model-resolver.test.cjs`. Keying
on the *whole* title instead would let a re-fold under a different batch label
slip through, which is exactly the shape #3271 took. Titles without a `folded:`
prefix, non-literal titles, and the same marker appearing in two *different* host
files are all left alone.

The ratchet deliberately covers only `bug-*`. Files named `feat-NNNN-*` /
`enh-NNNN-*` are *feature* test files — one (or one per suite) per feature is
the sanctioned layout (see the #443 strategy below), not a one-off regression
pattern. If `issue-*`/`perf-*` one-offs start accumulating the same way
`bug-*` did, extend the ratchet's regex and regenerate the allowlist.

## Why the size census exists

Why the census exists: each PR's CI measures only its own base plus its own
diff, so two PRs that are individually under a cap can be jointly over it, and
no run either of them produces can show that. The census does not solve that
directly — measuring on the merge result would, and was deliberately left out
of #4261's approved scope — but it makes the density that causes it legible
before the collision, which a passing run previously did not. It also replaces
the hand-written per-tier high-water comments in both guard files, which had
gone stale by several kilobytes and were themselves the reason the shrinking
margin went unnoticed.

## Why the size baselines were removed

`tests/workflow-size-baseline.json`, `tests/agent-size-baseline.json`,
`tests/fixtures/golden-install-parity/*.json`, `scripts/update-size-baseline.cjs`
(`npm run size:baseline`), and `scripts/git-merge-regen-driver.cjs`
(`npm run setup:merge-driver`) are all removed by
[#2724](https://github.com/open-gsd/gsd-core/issues/2724): they were pure
functions of the source tree, conflicted on every merge that touched them, and
their functions are now served by the differential attribution check above.
`tests/fixtures/install-tree/*.json` is the one artifact family that stays
committed and normally-merged (ADR-2719 §7) — it conflicts on 0 of 7, its diffs
are readable, and it preserves "the installer stopped shipping X" as a hard
absolute failure with no attribution reasoning involved. Regenerate it with
`npm run gen:install-tree` (folded into `npm run regen:derived`).

## Why the QA smell ratchet counts expectation failures

Expectation failures were invisible to the gate until
[#3597](https://github.com/open-gsd/gsd-core/issues/3597): `buildReport`
counted them in `totals.violations` while `collectFindings` read only oracle
violations, so a failing scenario printed `0 violations` and exited 0. The
`multi-workstream` scenario failed on every CI run for three weeks without
reddening a build. The invariant that keeps the two honest — asserted in
`tests/loop-walk.qa.test.cjs` — is:

```
collectFindings().violations.length
  + collectFindings().expectationFailures.length
  === report.totals.violations
```

Note also that `scripts/qa-smell-ratchet.cjs` only invokes its own `main()`
under `require.main === module`. That guard is what lets the QA suite
`require()` the script to test `collectFindings` without kicking off a real
20-scenario walk as an import side effect — the reason the gate's own logic
had no test before #3597.

## Why the live-config guard is narrow and report-only by default

Every `run-tests.cjs` invocation snapshots GSD's own install footprint in each
live runtime config directory before the suite and re-checks it afterwards. It
exists because the failure it catches is silent by construction: a test that
resolves a config directory from the ambient environment instead of a sandbox
writes into *your real* `~/.claude` (or `$GSD_HOME/.gsd`, or a Kimi
`config.toml`), and nothing reports it. CI cannot catch this class at all —
CI never has `CLAUDE_CONFIG_DIR` and friends set.

The guard watches only what GSD unambiguously owns — its top-level install
footprint plus `gsd-`-prefixed children of directories shared with the host
agent — never whole config roots, because a host agent legitimately writing
`history.jsonl` mid-run would make the guard cry wolf, and a guard that cries
wolf gets switched off.

Unset, the guard **reports and does not fail** — deliberately, not timidly. On
its first CI run it surfaced pre-existing leaks on the Windows lane, where
`os.homedir()` reads `USERPROFILE` and ~190 test sites sandbox `HOME` alone.
Those are real and worth fixing, but they are a different defect class, and a
brand-new gate that instantly reds an unrelated lane gets reverted rather than
obeyed. Windows lanes therefore stay report-only until that sweep lands; this
repo has the pattern already, in the `local/no-source-grep` ESLint rule that
shipped at `warn` and was promoted to `error` after its cleanup (ADR 452).

`GSD_SKIP_LIVE_CONFIG_GUARD` is a bypass on a safety check, so it is documented
here rather than left to be discovered in the source: an undocumented bypass is
one people eventually set without knowing what they turned off. If you need it
routinely, that is a bug report, not a workflow.

## Why the mergeability preflight is shaped the way it is

The bootstrap row is a consequence of the checkout being pinned to the base sha:
the preflight runs the script **as it exists on the base branch**, so the script
is absent on the pull request that introduces it, and on any branch whose base
predates it. Absent is not "conflicted" — it is one more thing the gate cannot
determine, so it takes the same fail-open path. The arm is self-healing and
never fires again once the script is on the base branch; a test pins it in place
so a future reader does not mistake it for dead code.

The verdict comes from `scripts/ci-pr-mergeability.cjs`, which polls
`GET /repos/{owner}/{repo}/pulls/{number}` until `mergeable` is non-null.
GitHub computes mergeability in an **asynchronous background job** and returns
`null` while it is in progress, so a single cold read is never authoritative —
the poll is required, not defensive.

Two properties are load-bearing and easy to break:

- **Only `mergeable === true` / `=== false` decides the verdict.** `null` is
  falsy, so a truthiness test (`if (!mergeable)`) would classify every cold read
  as a conflict and red every PR in the repo.
- **`mergeable_state` never decides the verdict.** Its `blocked` value means
  "required checks have not passed", which is true *while this very job is
  running* — gating on it self-deadlocks the pipeline. It is read for the
  failure message only.

### What it deliberately does not do

**It applies no label.** The gate does not add or remove `needs-review: merge-conflict`.
Eight caller workflows each invoke the preflight, so eight jobs would race to
add-or-remove one label on every PR event, and it would force
`pull-requests: write` into eight lanes that today hold `contents: read`.
`needs-review: merge-conflict` stays a maintainer triage label applied during PR
sweeps; the red check and its annotation are the machine signal.

**It changes no branch protection.** `.github/rulesets/main-protection.json` is
untouched and needs no new required context — GitHub natively refuses to merge a
pull request with conflicts, so the ruleset already blocks it. (Adding the check
as *required* before the workflow exists on the base branch would deadlock every
open PR until it landed.)

### What this does not replace

`scripts/ci-rebase-check.cjs` is unchanged and still runs inside each matrix job,
including its #2472 base-sha pin. The preflight is an early-exit optimization on
GitHub's asynchronously-computed view; the in-job merge remains authoritative and
covers the case where the base advances mid-run. **The gate is never a safety
property** — every path except an explicit `mergeable: false` fails open, so an
API outage simply restores the pre-#3833 behavior.

## Why the coverage gate has a blind spot

Coverage is evaluated by the dedicated `coverage-gate` job (moved out of the `test`
job by #2952, once sharding meant no single `test` runner saw the whole picture) and
stays single-lane (Ubuntu / Node 24 only) because multiplying coverage across
OS/runtime lanes adds cost without improving the threshold signal. Note the gate's
deliberate blind spot: it measures
`gsd-core/bin/lib/*.cjs` only — `scripts/`, `hooks/`, and `bin/` are
unenforced, and `stryker.config.mjs` additionally excludes ~48% of lib lines
from mutation testing (see the UNMUTATED list there). Widening either gate is
tracked work, not an accident to "fix" silently by raising thresholds.

## Why CI job timeouts are budgeted and reported

Every matrixed job — `test` in `test.yml`, `mutate` in
`mutation.yml`, `smoke` in `install-smoke.yml` — declares a `timeout-minutes`
cap. `tests/ci-test-job-timeout-budget.test.cjs` enforces that each checked-in
cap stays at least the **headroom factor** (1.5x) above a documented,
hand-measured cost for that job — now all three of the jobs above, not just
`test`/`coverage-gate`/`test-inert` as before.

`test-conformance` in `test.yml` (#4591, epic #4589 Phase 2) runs the
`scripts/lib/platform-conformance-tier.generated.cjs` file list on
`windows-latest` and `macos-latest`, both sharded since #5029 (the `shard:`
rows of the job's matrix in `test.yml` are the one statement of the counts) —
the sole gating signal for real-OS coverage (#4603 retired the parallel legacy
full-matrix safety-net job). It also declares a `timeout-minutes` cap and runs
the same in-job near-cap check described below. Since #5029 it **is** covered
by the headroom-factor gate. One cap covers every matrix row, so its
`LANE_COSTS` entry is the slowest row, windows or macOS shard. That entry, in
`tests/ci-test-job-timeout-budget.test.cjs`, is the one place the lane's
measurements are recorded: the long pole per layout, why each OS is split the
way it is (a slow macOS runner took the unsharded row past what the gate
admits), and the figure the cap may not drop below. It had been uncovered
since #4591, which is how it drifted to a 34m long pole against a 45m cap and
began cancelling shards whose every chunk passed (#4935). The same file also
projects the Windows rows' worst shard from the shard count `test.yml`
declares and the current tier size, at the slow-runner skew #5029's triage
measured, and fails when that shard would land in the near-cap band. At the
tier size #5029 merged with, it fails at the layout #5029 replaced and passes
at the one `test.yml` declares; the comment on the model says how far that
verdict depends on the fit.

#5071 → #5097 has since priced win32 files by win32 measurements, which evened
out the shards. Whenever this lane is resharded again, in either direction,
re-measure from the new runs and set the entry from the slowest row; never
scale the existing figure. The per-shard balance check (`SHARD_BALANCE`, see
[Read CI timeout signals](../how-to/read-ci-timeout-signals.md)) must then be
re-baselined too; a test fails until it is.

**`.platform.test.cjs` siblings (#5074).** A large file whose platform signal sits in a few tests is split into `tests/<name>.platform.test.cjs` (selected by the tier) and `tests/<name>.test.cjs` (Linux only); `gen-platform-conformance-tier.cjs` fails with `platform split invariant violated` when the split is broken. See [Split platform-sensitive tests](../how-to/split-platform-sensitive-tests.md).

Two runtime mechanisms sit on top of that static gate, both new in #4036:

- **In-job near-cap check** (`scripts/ci-check-job-near-cap.cjs`) — the last
  step of each of the three jobs computes elapsed-vs-cap from a start-time
  marker recorded as that job's first step. At >=90% of budget it emits a
  `::warning::` annotation (visible in the PR Checks UI) and a
  `$GITHUB_STEP_SUMMARY` block. Advisory only — it never fails the job. Known
  limit: it cannot fire for a job actually killed by the timeout, since a
  killed job never reaches its last step. That case is caught by the second
  mechanism instead.
- **Scheduled trending report** (`.github/workflows/ci-timeout-report.yml`,
  `scripts/ci-timeout-report.cjs`) — runs daily and on `workflow_dispatch`. It
  polls GitHub's Actions REST API for recently completed jobs across
  `test.yml`, `mutation.yml`, and `install-smoke.yml`, resolves each job's
  declared cap (a literal `timeout-minutes` for `test`/`test-conformance`/`smoke`, or
  `scripts/mutation-matrix.cjs`'s `COVERED[<module>].timeoutMinutes` for
  `mutate`'s per-module shards), and appends any new `(runId, jobName)`
  records to `tests/ci-timeout-budget-history.jsonl`. Unlike the in-job check,
  this also catches jobs killed by an actual timeout breach — GitHub's Jobs
  API still reports `started_at`/`completed_at` for a cancelled job. The new
  rows travel in one rolling, data-only PR (branch `chore/4036-ci-timeout-budget-history`,
  titled `chore(#4036): CI timeout budget history update`), since `next` is a
  protected branch and nothing pushes to it directly — the same constraint
  `auto-backmerge.yml` already works within. Each run rebuilds that branch on
  the current `next` tip with every pending row; the workflow approves the PR
  when it is provably its own data-only PR, then auto-merges it once required
  checks pass. Until the org allows GitHub Actions to approve PRs, it waits for
  one human approval (the run logs a warning).

This does not retune any `timeout-minutes` value, rebalance shard composition,
or trim what runs in shard 1 — those stay maintainer policy calls made from
the accumulated history, not something either mechanism decides on its own.
