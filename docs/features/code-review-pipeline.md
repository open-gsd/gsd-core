---
id: 93
title: Code Review Pipeline
group: v1.34.0 Features
---

**Commands:** `/gsd-code-review`, `/gsd-code-review --fix`

**Purpose:** Structured review of source files changed during a phase, with a separate auto-fix pass that commits each fix atomically.

**Requirements:**
- REQ-REVIEW-01: `gsd-code-review` MUST scope files to the phase using SUMMARY.md and git diff fallback
- REQ-REVIEW-02: Review MUST support three depth levels: `quick`, `standard`, `deep`
- REQ-REVIEW-03: Findings MUST be severity-classified: Critical, Warning, Info
- REQ-REVIEW-04: `gsd-code-review --fix` MUST read REVIEW.md and fix Critical + Warning findings by default
- REQ-REVIEW-05: Each fix MUST be committed atomically with a descriptive message
- REQ-REVIEW-06: `--auto` flag MUST enable fix + re-review iteration loop, capped at 3 iterations
- REQ-REVIEW-07: Feature MUST be gated by `workflow.code_review` config flag
- REQ-REVIEW-08: `workflow.code_review_point` MUST select which loop point the automatic review step registers at (`execute:post` default, or `execute:wave:post`), independent of the `workflow.code_review` on/off gate and of manual `/gsd-code-review` invocation (#3661)
- REQ-REVIEW-09: The in-phase `code_review_gate` MUST report the per-severity counts it parses from REVIEW.md, so a review with one `info` finding is distinguishable from a review with a Critical
- REQ-REVIEW-10: Each finding MUST carry a recorded disposition, so a triaged finding is distinguishable from a forgotten one

**Config:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workflow.code_review` | boolean | `true` | Enable code review commands |
| `workflow.code_review_point` | string | `execute:post` | Loop point for the automatic review: `execute:post` (once per phase, default) or `execute:wave:post` (once per completed wave, scoped to what changed since the phase's prior review). See below. |
| `workflow.code_review_depth` | string | `standard` | Default review depth: `quick`, `standard`, or `deep` |
| `workflow.code_review_depth_overrides` | array | `[]` | Ordered `{ paths, depth }` rules that escalate depth for directories matched by path prefix against the changed-file set (#2554). See below. |

**Reviewing per wave instead of per phase (#3661)**

Setting `workflow.code_review_point` to `execute:wave:post` moves the automatic review from
"once, after the whole phase's waves have all landed" to "once per completed wave." Each
wave's review scopes to what changed since the phase's *previous* review — the whole phase's
diff on the first wave, then just that wave's diff on every wave after — so review batches
stay small instead of growing with the phase. A finding introduced early is caught after the
wave that introduced it, not after the last wave of the phase.

This only affects the *automatic* dispatch inside a wave-based phase execution. Manual
`/gsd-code-review <phase>` runs are gated by `workflow.code_review` alone and are unaffected
by this key. `/gsd-autonomous` and `/gsd-quick` have no wave granularity of their own, so
setting this to `execute:wave:post` means automatic review does not run inside those two
flows — the same way every other wave-scoped capability step already behaves for them.

**Path-scoped code review depth overrides**

`workflow.code_review_depth_overrides` matches rules against the review's changed-file set by whole-segment directory-path prefix — `src/auth` matches `src/auth/token.ts` and `src/auth` itself, never `src/authfoo/x.ts` or `docs/src/auth/x.ts` — and is case-sensitive, following git.

Escalation is **whole-review, not per-file**: depth is a single scalar handed to the reviewer agent, not a per-file setting, so the strongest matching tier across the whole rule set applies to every file in the review — a sensitive file is never reviewed shallowly because it shared a review with an unrelated one.

v1 supports **directory-prefix matching only, not glob syntax**: no glob engine (`minimatch`, `picomatch`, `fast-glob`) exists in this project and none was added for this feature. A path containing `*` or `?` (e.g. `src/auth/**`) is a configuration error rather than a silent near-miss, because accepting it as sugar for a prefix would make unsupported patterns look armed when they match nothing. Every use case in the issue is expressible as a directory prefix. See [Scope code review depth by path](how-to/scope-code-review-depth-by-path.md) for the resolution order, error table, and a worked example.

**Optional external reviewer lanes (#4209):** `/gsd-code-review` accepts the same reviewer-lane flags as `/gsd-review` — any flag the roster declares (run `gsd_run review-lane flags` to list them for your installation, e.g. `--codex`, `--agy`). No reviewer-lane flag is the default and is byte-for-byte unchanged from before #4209: zero lane selection, plan, or invoke calls, and only the internal `gsd-code-reviewer` agent runs. Passing one or more flags asks those lanes to independently review the same already-resolved file scope alongside the internal agent, through the same shared capability-trait interpreter and `review-lane plan`/`invoke` machinery `/gsd-review` uses — no second implementation. Each lane's prompt carries only the repository root, canonical file paths, review depth, and base SHA, never source file contents, under four fixed prohibitions (no source mutation, no test execution, no background processes, no polling). External findings are unverified corroborating evidence: `gsd-code-reviewer` independently re-verifies every claim against the actual source before writing it to `REVIEW.md`, so there remains exactly one `REVIEW.md` schema regardless of how many lanes ran. An explicitly requested lane that is unavailable or fails is reported as a warning, never silently dropped and never a raw-CLI fallback. This is separate from `/gsd-review`, which reviews `PLAN.md` files before execution, not source code.
**In-phase review reporting and disposition**

`/gsd-execute-phase`'s `code_review_gate` runs code review, then reports what it found:

```
Code review: 23 findings — 1 critical, 9 warning, 8 info.
Consider running: /gsd-code-review 1 --fix
```

Both `critical:` and its documented tier-equivalent `blocker:` are accepted. A REVIEW.md written
without a `findings:` block has no counts to report, and the gate falls back to the countless form
rather than printing a half-filled line.

The gate then writes `<NN>-REVIEW-DISPOSITION.md` beside the review — one row per finding ID,
defaulting to `open`:

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| CR-01 | critical | open | - |
| WR-01 | warning | fixed | 01-REVIEW-FIX.md |

`open` means recorded but not yet triaged, and it is the only value the gate assigns on its own.

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
drop is reported on the console, naming the ID and what had been decided — for a *recorded* decision.
A prior row still sitting at `open` is replaced silently, and deliberately: `open` means nobody had
decided anything, so there is no decision to lose. Preserving a recorded decision in the file
was tried and withdrawn: it needed a second identity scheme and produced a fresh defect on each of
three review passes. Recovery is the ledger's own git history where `commit_docs` is on — which is
why the console reports the drop rather than pointing at a commit that may not exist.

**Two residuals, since (ID, title) is not proof of identity.** A ledger written before titles were
recorded carries none, so its decisions are inherited on the ID alone — refusing there would reset
every decision in every existing ledger, which is the loss the guard exists to prevent. And two
genuinely distinct findings that share both an ID and a title are indistinguishable to this key.
Separating them needs a second identity scheme, which is the thing that was just withdrawn.

Reconciliation applies an outcome only when the fix report names the **same** finding, because
finding IDs are reused across re-reviews and a stale report would otherwise declare a brand-new
`CR-01` already fixed. Titles are compared with runs of whitespace collapsed, so a fixer that
re-spaces a title still reconciles. A title that differs otherwise — including one **wrapped across
lines**, since a `###` heading is one line and the continuation is a separate paragraph — leaves the
row `open` and is reported, naming the ids it could not reconcile, rather than passing silently. The report does not claim to
know whether such a report is stale or merely re-titled, because it cannot tell.

The disposition column is a closed vocabulary — `open`, `fixed`, `skipped`, `deferred`. A
hand-edited value outside it is not treated as a decision: the row falls back to `open`, so a
typo cannot quietly mark a phase as triaged.

Severity comes from the section a finding sits under (`## Critical Issues`, `## Warnings`,
`## Info`) when the review uses those headings, and from the ID prefix otherwise. The section is
the reviewer's own statement of severity, so a Critical filed under `## Critical Issues` is
recorded critical even if its ID was mis-numbered `WR-04`. That severity is then **remembered**:
a row the current review no longer reports, or reports under no recognized heading, keeps the
severity the ledger recorded rather than having it re-inferred from the ID prefix — so the
mis-numbered `WR-04` above stays `critical` on the second run, deferred or not. The precedence is
the current review's section, then the recorded value, then the prefix; the recorded value is
inherited only while the ID still names the same finding, by the same title check the disposition
uses, so a reused ID starts from its own review. That check has the same compatibility arm the
disposition has: a ledger written before titles were recorded carries no title to compare, so its
severities — like its decisions — inherit on the ID alone.

If the review's `total:` exceeds the number of findings whose headings the gate could parse, the
shortfall is stated — on the console and as an `unparsed:` key in the ledger's frontmatter. A
finding the gate cannot record is the one a human most needs to see, so it is never dropped
silently. The one input that produces no shortfall is a `findings:` block that disagrees with
itself: where `critical` (or `blocker`), `warning` and `info` are all present, numeric and do not
sum to `total`, the gate has no trustworthy number to reconcile against and withholds the key
rather than reporting a figure derived from one — the same input on which the console line
already withholds the severity breakdown. Counts that are merely absent, partial or non-numeric
are not a disagreement, and the shortfall is still reported from `total` alone. `deferred` is the one disposition the gate never writes: it is recorded by hand, and the
reason recorded beside it in the Source cell is preserved across re-runs, a literal `|` included
once escaped. One exception, because it cannot be resolved: a reason ending in the literal phrase
*(not in the current review)* loses that trailing phrase, since it is indistinguishable from the
carried marker the gate appends. The alternative is worse — a stored marker never leaves, so a
carried finding that later reappears would keep claiming it is absent from the review reporting it.

Re-running the gate keeps every row it can, so a decision recorded here is not
overwritten by a later pass. A finding the current review no longer reports — `--auto` re-reviews
and rewrites REVIEW.md, so this happens routinely — is **carried** rather than dropped, marked
*(not in the current review)*. That holds whether or not it was triaged: losing a decided row would
erase the record that the finding was seen, and losing an *untriaged* one would erase the record
that it was never answered, which is the trace this ledger exists to keep. The cost is that a
renumbered finding shows under both IDs until the old row is decided; the marker makes that legible.
A run that changes nothing rewrites nothing, so a re-executed phase does not produce a docs commit
with no content.

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

The record is a sibling artifact rather than a section inside REVIEW.md because `--auto`'s
re-review loop rewrites REVIEW.md on every iteration — a ledger kept inside it would not survive
the next pass — and because REVIEW.md has a single writer (`gsd-code-reviewer`) that the gate is
not. The gate remains advisory throughout: it reports and records, and never blocks phase
completion.
