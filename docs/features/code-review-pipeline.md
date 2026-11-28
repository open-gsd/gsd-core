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

Escalation is **whole-review, not per-file**: depth is a single scalar handed to the reviewer agent, not a per-file setting, so the strongest matching tier across the whole rule set applies to every file in the review (see [the design record](../explanation/review-pipeline-design.md)).

v1 supports **directory-prefix matching only, not glob syntax**. A path containing `*` or `?` (e.g. `src/auth/**`) is a configuration error rather than a silent near-miss (see [why no globs](../explanation/review-pipeline-design.md)). See [Scope code review depth by path](how-to/scope-code-review-depth-by-path.md) for the resolution order, error table, and a worked example.

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

**Reconciliation and identity (the arguments are in [About the code-review pipeline's design choices](../explanation/review-pipeline-design.md#how-the-disposition-ledger-reconciles-and-what-it-cannot-prove)).** The in-phase gate runs before `<NN>-REVIEW-FIX.md` exists, so every row it writes is `open`; `/gsd-code-review <N> --fix` records `fixed` and `skipped`. `--auto` iterations are reconciled from the `<NN>-REVIEW-FIX.iterN.md` backups, newest first, which are removed after the ledger has read them. A decision is carried forward only while the ID still names the same finding (the ledger records each title); a reused ID is recorded `open` and the earlier decision loses its row, reported on the console (#5802).

**Ids with a review-scoped prefix are refused loudly, never skipped (#5802).** The id grammar is
`<CR|BL|WR|IN>-NN`. A review heading such as `### W6-CR-01: …` is not read as a finding; it is counted
into the `unparsed:` shortfall and named on the console ("carry a prefix before the id"). The same holds for a prefixed heading in a fix report (named, not reconciled) and for a multi-segment
prefix (`W6-R2-CR-01`). A ledger row
outside the grammar (`| R1-WR-01 | … |`, an indented row, or a row with an unknown disposition) is named on the console and
kept verbatim after the generated rows, not deleted by the whole-file rewrite; it is not counted in
`open:` or `total:`. When a regenerated row takes the id of such a row, the row is reset to `open`
(a value outside the enum is coerced to the safe default) and the console names it with the
disposition and reason it held, so a hand-set value is never replaced silently. A disposition is
read case-insensitively (`Deferred` is `deferred`). Two rows for one id are named (the last is used), and
console names are masked for control characters and capped. A frontmatter `- id:` entry outside the grammar ends
the previous entry, so its `title:` is never attributed to another finding.

**Residuals:** a ledger written before titles were recorded inherits decisions on the ID alone, and two distinct findings sharing both ID and title are indistinguishable to the key.

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
*(not in the current review)* loses that trailing phrase (see [the carried-marker exception](../explanation/review-pipeline-design.md)).

Re-running the gate keeps every row it can, so a decision recorded here is not
overwritten by a later pass. A finding the current review no longer reports — `--auto` re-reviews
and rewrites REVIEW.md, so this happens routinely — is **carried** rather than dropped, marked
*(not in the current review)*. That holds whether or not it was triaged: losing a decided row would
erase the record that the finding was seen, and losing an *untriaged* one would erase the record
that it was never answered, which is the trace this ledger exists to keep. The cost is that a
renumbered finding shows under both IDs until the old row is decided; the marker makes that legible.
A run that changes nothing rewrites nothing, so a re-executed phase does not produce a docs commit
with no content.

The ledger is read, rebuilt and written whole with no lock, so two overlapping writers could lose an update; no lost update has been reproduced. It is not the Review Dispositions Ledger of reviews-mode planning ([ADR-3806](../adr/3806-review-dispositions-ledger.md)).

The record is a sibling artifact rather than a section inside REVIEW.md (see [why a sibling file](../explanation/review-pipeline-design.md)).
The gate remains advisory throughout: it reports and records, and never blocks phase completion.

**Necessity findings (#4100):** at `standard` and `deep` depth the reviewer also asks whether the
problem a piece of code addresses can occur in this stack at all. Code that is correct and reachable
but guards against nothing (an impossible-state guard, a concern another layer already owns, a
pattern whose prerequisites do not hold, a requirement that has lapsed, an abstraction with one
instantiation) is reported as an ordinary Warning or Info finding carrying a `**Category:** necessity`
line, never as Critical, and must cite the evidence that the state cannot occur. The frontmatter
`necessity:` key counts them as a subset of `warning` + `info`; `total:` and the finding IDs are
unchanged, so the disposition ledger records them like any other finding. Removing code is a scope
decision, so `--fix` skips necessity findings and `--fix --all` includes them last, each marked for
human verification. `--fix --auto` also stops once the fixer reports nothing left in its scope,
rather than re-running to its iteration cap over findings it will never touch. See
[Resolve necessity findings](../how-to/resolve-necessity-findings.md).

**CI/CD pipeline files (#4101):** workflow files, Dockerfiles, compose files and deploy scripts get
their own reliability rubric, recognized by path rather than extension. Their defects rarely fail a
test; they surface at release or deploy time, so the reviewer is the only automated gate that reads
them before merge. At `standard` and `deep` depth the reviewer checks for non-idempotent steps,
missing job timeouts, deploy workflows without a concurrency guard, per-environment rebuilds instead
of build-once/promote, deploys without a health check or rollback, `continue-on-error` on a
load-bearing step, static cloud credentials where OIDC is supported, and unpinned third-party
actions. The rubric is read on demand from `gsd-core/references/cicd-review-patterns.md`, which also
lists what does not count (global tool installs, reusable-workflow calls, tag and SHA pins). `quick`
depth runs the mechanical subset on GitHub Actions workflows only. Pipeline findings are Warning;
hardcoded secrets stay Critical. The REVIEW.md format and the fixer scope are unchanged. Quick mode's
own check list now names its checks and runs each from one command block, which also closes a gap:
quick reviews now catch secret values containing `-`, `.` or `/`, `passthru`, and commented-out code.
See [Resolve CI/CD pipeline findings](../how-to/resolve-cicd-pipeline-findings.md).
