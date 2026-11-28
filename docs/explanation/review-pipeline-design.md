# About the code-review pipeline's design choices

Why the review-depth, disposition-ledger and record-artifact rules are shaped the way they are. The behavior itself is described in [Code Review Workflow](../USER-GUIDE.md#code-review-workflow); the flags and lanes are in [CLI tools](../CLI-TOOLS.md).

## Depth escalation is whole-review, not per-file

Depth is a single scalar handed to the reviewer agent — the strongest matching tier across the whole rule set applies to every file in the review. The reason: a sensitive file must never be reviewed shallowly because it happened to share a review with an unrelated one. A per-file depth would make the review's quality depend on how changes were batched.

## Directory prefixes only, no globs

v1 matches `workflow.code_review_depth_overrides` rules by whole-segment directory prefix and deliberately does not accept glob syntax. No glob engine (`minimatch`, `picomatch`, `fast-glob`) exists in this project and none was added for the feature. A path containing `*` or `?` is a configuration error rather than a silent near-miss, because accepting it as sugar for a prefix would make unsupported patterns look armed when they match nothing. Every use case in the originating issue is expressible as a directory prefix.

## Why the ledger replaces an `open` row silently

The disposition ledger keys rows on the finding ID; two rows under one ID is an ambiguity, not a record, so a new decision displaces the prior row and the drop is reported on the console. A prior row still sitting at `open` is replaced silently: `open` means nobody had decided anything, so there is no decision to lose. Preserving a recorded decision in the file was tried and withdrawn — it needed a second identity scheme and produced a fresh defect on each of three review passes. Recovery for a displaced recorded decision is the ledger's own git history where `commit_docs` is on.

## The carried-marker exception

A reason ending in the literal phrase *(not in the current review)* loses that trailing phrase on carry-over, because it is indistinguishable from the marker the gate itself appends. The alternative is worse: a stored marker never leaves, so a carried finding that later reappears would keep claiming it is absent from the review that reports it.

## Why the record is a sibling file, not a REVIEW.md section

`--auto`'s re-review loop rewrites REVIEW.md on every iteration — a ledger kept inside it would not survive the next pass — and REVIEW.md has a single writer (`gsd-code-reviewer`) that the disposition gate is not. The gate reports and records; it remains advisory and never blocks phase completion.

## Why parallel reviewer lanes fail safe and keep sequential ordering

Reviewer lanes in one pass have no data dependency on each other, so `review.parallel_lanes` (#3034) dispatches them concurrently when opted in. Three design choices follow.

### The guard is strict equality, and it fails safe

Only the exact value `true` opts in — `"1"`, `"yes"` and `"TRUE"` all stay sequential, so a mistyped config gets the conservative behavior rather than concurrent requests at a rate-limited provider. A failure to read the config falls back to sequential too. This polarity is deliberately the opposite of the `commit_docs` guard, which fails open: there, failing open preserves user intent; here it would fire the very requests the default exists to prevent.

### Result ordering is unchanged in both modes

Per-lane results are written to slug-scoped files and concatenated in reviewer-selection order after the join, so `gsd-review-lane-results.jsonl` reads identically whether lanes ran sequentially or concurrently. Completion order never reaches the artifact. This also means concurrent lanes never share an append handle — a lane result larger than the pipe-atomicity bound cannot interleave and corrupt the `models:` / `model_sources:` frontmatter that `write_reviews` renders from that file.

### Per-lane semantics are untouched

Timeouts, prompt budgets, the diagnostic stub for an empty or failed lane, explicit-lane failure ([ADR-2782](../adr/2782-reviewer-lane-capability-surface.md) D4), trust/egress checks and result-file layout all behave exactly as they do sequentially. A failing lane does not abort its siblings.

## How the disposition ledger reconciles, and what it cannot prove

**Where the reconciliation happens, which is not where you might expect.** The in-phase gate runs
immediately after review, and at that moment `<NN>-REVIEW-FIX.md` does not exist — the gate invokes
review with neither `--fix` nor `--auto` — so every row it writes is `open`. The `fixed` and
`skipped` outcomes are reconciled by `/gsd-code-review <N> --fix`, which records them once the fix
report is on disk. Running the gate alone therefore tells you what was found; running `--fix` is
what records what happened to it.


**`--auto`'s iterations are reconciled too, and that takes reading more than the final report.**
The loop overwrites `REVIEW-FIX.md` on every pass and the re-review stops reporting a finding once
it is fixed, so a finding closed in iteration 1 appears in neither final artifact. The gate
therefore also reads the per-iteration backups the loop writes (`<NN>-REVIEW-FIX.iterN.md`), newest
first, so the most recent statement about an ID wins; the backups are removed after the ledger has
read them, not before. Without this a fully successful multi-iteration run recorded its early fixes
as `open (not in the current review)` — indistinguishable from a finding that vanished for an
unrelated reason, which is the one distinction this ledger exists to make. A finding a fix report
decided but the current review no longer reports gets a row of its own, carrying that decision and
marked *(not in the current review)*.

A converged `--auto` run also reaches the gate with a clean review and, on a direct
`/gsd-code-review` invocation, no ledger from the in-phase gate. A fix report on disk is reason
enough to record: without that, a run in which every finding was fixed and committed produced no
disposition record at all.


**A decision belongs to a finding, not to an ID.** IDs are reused across re-reviews — `--auto`
renumbers — so the ledger records each finding's title alongside its disposition, and a recorded
decision is carried forward only while the ID still names the same finding. Without that, a prior
`CR-01 fixed` would be inherited by a brand-new `CR-01`, which is a false decision in the one
artifact whose purpose is telling triaged from forgotten.


**The limitation that follows, stated rather than hidden.** When an ID *is* reused, the new finding
is recorded `open` (nobody decided anything about it) and the earlier decision **loses its row** —
the ledger keys rows on the finding ID, and two rows under one ID is an ambiguity, not a record. The
drop is reported on the console, naming the ID and what had been decided — for a *recorded* decision,
on every path that displaces one: a plain re-review, a fix report that decides the new finding, and a
row carried only by a fix report (#5802).
A prior row still sitting at `open` is replaced silently (see [why the replacement is silent](#why-the-ledger-replaces-an-open-row-silently)).
Recovery is the ledger's own git history where `commit_docs` is on — which is why the console
reports the drop rather than pointing at a commit that may not exist.

**Two residuals, since (ID, title) is not proof of identity.** A ledger written before titles were
recorded carries none, so its decisions are inherited on the ID alone — refusing there would reset
every decision in every existing ledger, which is the loss the guard exists to prevent. And two
genuinely distinct findings that share both an ID and a title are indistinguishable to this key.
Separating them needs a second identity scheme, which is the thing that was just withdrawn.

One residual is concurrency: the ledger is read, rebuilt and written whole, with no lock. Two
dispatchers can run this step (`code_review_gate` and `code-review-fix`'s `record_disposition`) and
a human is invited to hand-edit the file, so two writers overlapping would lose one's update. This is
the shape #3780 reported for `WINDOWS.md` under parallel executors, closed there by a cross-process
lock (#4681); the disposition step does not take that lock. No lost update has been reproduced; the
window is stated so it is not mistaken for a guarantee.

Not to be confused with the **Review Dispositions Ledger** of reviews-mode planning
([ADR-3806](../adr/3806-review-dispositions-ledger.md), `docs/features/review-dispositions-ledger.md`):
that one is a `## Review Dispositions Ledger` section inside `PLAN.md`, append-only per round, over
`REVIEWS.md` findings. This artifact is a sibling file beside `REVIEW.md`, rewritten idempotently
with rows carried. Same word, different inputs, writers, files and durability rules; neither governs
the other.

---

## Related

- [Code Review Workflow](../USER-GUIDE.md#code-review-workflow)
- [Review dispositions ledger](../adr/3806-review-dispositions-ledger.md)
- [Multi-agent orchestration](multi-agent-orchestration.md)
- [Security model](security-model.md)
