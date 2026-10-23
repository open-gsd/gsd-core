# #5019 lane-evidence: reviewer-hop evidence (AC1)

Records an on-branch run showing that a finding sourced only from an external reviewer lane survives the `--auto` re-review hop. Measured by running the shipped bash fences and a real `gsd-code-reviewer` agent.

## Setup

- Head: `fbca9bd7a` (fix/5019-lane-evidence-r2). Base: `09b6a836c` (`origin/next`, clean detached checkout).
- Host: Linux 7.2, Node v26.12.0. Reviewer: `gsd-code-reviewer`, model `sonnet`, effort `low`, fresh context per trial, one trial at a time, trial order shuffled (seed 5456).
- Fixture: prior `REVIEW.md` holds only CR-01 (plaintext password compare, `src/auth.js:7`). The review scope is `src/messages.js` and `src/auth.js`. The cursor lane file says `src/messages.js:5` reads "15 minutes" while `LOCKOUT_MINUTES = 30` in `src/config.js:4`; `config.js` is outside the scope. The lane file is the only way the scope-bound reviewer is told about it.
- Assembly: the head prompt comes from the shipped `dispatch_reviewer_lanes` fence (persist step, `code-review.md`), the `commit_review` fence and the read snippet in `code-review-fix.md`, each run in a fresh `bash`. `dispatch-step` is stubbed to copy the lane file. Base uses the same fences from `origin/next`, which has no evidence block.
- One line is appended to both arms: relative file paths resolve against the trial's project root.
- Retained = the new `REVIEW.md` has a finding section naming the 15-versus-30-minute mismatch (`LOCKOUT_MINUTES`/`config.js` with 30, or "15 min" with 30). Tagged = that section carries `(external: cursor)`.

## Results

| Arm | Iteration | Valid trials | Retained | Tagged |
|---|---|---|---|---|
| head | 2 | 6 | 6 | 4 |
| base (`next`) | 2 | 6 | 0 | 0 |
| head, chained | 3 | 3 | 3 | 1 |

One-sided Fisher exact test, head 6/6 against base 0/6: p = 1/924 = 0.001.

Iteration 3 re-runs the reviewer on the same fixture after iteration 2 with a no-op fixer. Between iterations the lane-evidence file and the `gsd-review-lanes-*` directory still exist (script assertion, 3/3). Iteration 3 is partly confounded: the prior `REVIEW.md` already lists the finding.

## Caveats

- A scope-bound reviewer can find the mismatch without the lane file if it reads `config.js`; here none of the 6 base trials did.
- The `(external: cursor)` tag is not reliable: it was present in 4 of 6 head iteration-2 trials and 1 of 3 iteration-3 trials. Retention does not depend on it.
- One head trial was voided and rerun: the reviewer returned its findings in chat and wrote no file. The voided output did keep and tag the finding.
- The first version of the retention check also matched unrelated mentions of `messages.js:5` and flagged one base trial; it was tightened to the real mismatch before any further trial, and all base trials were re-checked with the final check. Trial files were not kept, so head trials were not re-checked: they were scored when run, and the tightening only removed matches, so a head trial scored before it could be overstated. `check.sh` has since also accepted "15 min" wording and a no-new-review exit; neither was applied to the recorded trials.
- n is small; these runs are evidence for this fixture only, not a general rate.

## Reproduce

Harness and commands: [`5019-reviewer-hop-harness/README.md`](5019-reviewer-hop-harness/README.md).
