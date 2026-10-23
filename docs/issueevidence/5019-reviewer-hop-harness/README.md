# #5019 reviewer-hop replication harness

Replicates the run recorded in [`../5019-lane-evidence-reviewer-hop.md`](../5019-lane-evidence-reviewer-hop.md) (that note is canonical for results). It runs the shipped bash fences from the checkout under test and a base ref; only `review-lane dispatch-step` is stubbed. The reviewer step is manual and metered.

Needs `bash`, `node`, `git`, `tar`. Not shipped: `docs/` is outside `package.json` `files`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HEAD_WT` | `git rev-parse --show-toplevel` of this dir | checkout under test |
| `BASE_REF` | `origin/next` | base; `gsd-core/` is exported from it with `git archive` on first use |
| `BASE_WT` | `$HOP_WORK/base-src` | where the base export goes |
| `HOP_WORK` | `${TMPDIR:-/tmp}/5019-reviewer-hop` | scratch output (arms, trials) |

## Commands

Run from anywhere inside the checkout: `H=$(git rev-parse --show-toplevel)/docs/issueevidence/5019-reviewer-hop-harness`.

1. `$H/build.sh head` and `$H/build.sh base` print `built $HOP_WORK/<arm>`. They write `<arm>/project` (fixture, plus lane dir and `01-REVIEW-lane-evidence.md` for head) and `<arm>/prompt.iter2.txt`.
2. `$H/trial.sh <arm> <n>` prints `$HOP_WORK/<arm>/trial-<n>/prompt.txt`. The head prompt has an `<external_reviewer_evidence>` block naming the cursor lane file; the base prompt has none.
3. Dispatch the reviewer, fresh context per trial, one at a time: `Agent(subagent_type='gsd-code-reviewer', model='sonnet', effort='low')` with `prompt` = the contents of that `prompt.txt`, verbatim. It writes `trial-<n>/project/phase/01-REVIEW.md`.
4. `$H/check.sh $HOP_WORK/<arm>/trial-<n>` prints `RETAINED=0|1` and `TAGGED=0|1`. Exit 2 if the reviewer wrote no file (`no .../01-REVIEW.md`) or left the given review unchanged (`reviewer wrote no new review`): void the trial and rerun.
5. Iteration 3, head only, after a no-op fixer: `$H/iter3.sh $HOP_WORK/head/trial-<n>` prints `OK evidence file + lane dir survive iteration 2` on stderr, then the iteration-3 prompt on stdout. Dispatch it as in step 3, then `check.sh`. Exit 1 with `FAIL ...` otherwise.

Dry run without a reviewer: after step 2, write any `01-REVIEW.md` with a `status:` line and a `## WR-01` section mentioning `LOCKOUT_MINUTES` and `30`, then run steps 4 and 5; expect `RETAINED=1`.

## Recorded outcomes (`results.txt`, raw log)

| Trial | Result |
|---|---|
| base-1 .. base-5 | `RETAINED=0 TAGGED=0` each |
| base-6 | `R=0` |
| head-1 | `RETAINED=1 TAGGED=1` |
| head-2 | `RETAINED=1 TAGGED=1` |
| head-3 | `RETAINED=1 TAGGED=1` |
| head-4 | `RETAINED=1 TAGGED=0` |
| head-5 | `RETAINED=1 TAGGED=1` |
| head-6 | VOID: reviewer returned findings in chat, wrote no file; rerun as head-7 |
| head-7 | `RETAINED=1 TAGGED=0` |
| iter3 head-1 | `RETAINED=1 TAGGED=0` |
| iter3 head-2 | `RETAINED=1 TAGGED=1` |
| iter3 head-3 | `RETAINED=1 TAGGED=0` |

Trial order (seed 5456): `base:6 base:4 base:3 head:1 head:5 base:5 base:2 base:1 head:4 head:3 head:2 head:6`. Iteration-3 chain ran on head trials 1, 2, 3 (iteration-2 outputs saved as `01-REVIEW.iter2.md`).
