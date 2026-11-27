# ADR-4630: One Canonical Dispatch-Identity Owner and a Recorded Isolation Decision

- **Status:** Accepted
- **Date:** 2026-09-13
- **Issue:** [#4630](https://github.com/open-gsd/gsd-core/issues/4630) — epic (`type: chore`, `area: agents`)
- **Absorbs:** [#4222](https://github.com/open-gsd/gsd-core/issues/4222), [#4561](https://github.com/open-gsd/gsd-core/issues/4561), [#4594](https://github.com/open-gsd/gsd-core/issues/4594) — three `confirmed-bug` issues that are the same missing owner reported at two ends of one wire
- **Framed by:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (host-integration interface — agent dispatch is interface point 2)
- **Pattern copied from:** [ADR-2121](2121-phase-identifier-parsing-consolidation.md) (phase-identifier consolidation: seam + migration + anti-divergence guard). This ADR reuses its phase-token grammar and its drift-lint shape deliberately.
- **Amended:** 2026-11-05 by Phase 2 ([#4904](https://github.com/open-gsd/gsd-core/issues/4904)) — Decision 2 defines the `IsolationDecision`'s provenance field, `decided_by` (`resolver` | `caller`, absent reads as `caller`), and states which decisions a re-query holds. Without it, Decision 2's hold and #4232's re-derivation cannot both be true. The record also carries `decided_at`, when the decision was made, so a hold that later gates renew lapses ten minutes after the degrade. See *The record states who decided it* under Decision 2, and *A plan-scoped write does not re-derive the base check* for where that re-derivation stops. Decision 3 gains the workflow-shell validity lists as a second class of pinned copy.
- **Scope note:** unlike ADR-2121, this ADR does **not** land as a code-free Phase 0. It ships alongside Phase 1's implementation because the epic's phase sub-issues could not be created in the session that executed it; the decisions below were nonetheless fixed before that implementation was written, and Phases 2 and 3 execute against this file.

## Context

A GSD phase execution decides, per dispatch, whether the executor runs isolated in a git
worktree or sequentially in the primary checkout. That decision is:

1. **produced** in workflow shell (`execute-phase/steps/executor-isolation-dispatch.md`, `per-plan-worktree-gate.md`, `references/dispatch-isolation-gate.md`, `execute-plan.md`),
2. **transported** through a run-scoped sentinel at `.gsd/dispatch-isolation-sentinel.json`,
3. **consumed** by two guard hooks (`hooks/gsd-agent-isolation-guard.js` for Claude-shaped hosts, `hooks/gsd-cursor-subagent-start.js` for Cursor).

At every hop, both sides hand-roll their own copy of the format. #4561 states the census
directly: the dispatch-isolation membership is **hand-written at eight uncross-checked
sites**. The consequence is not a style complaint — it is three confirmed bugs:

| Issue | Defect |
|---|---|
| #4222 | A plain `dispatch-isolation` re-query re-resolves the host *capability* and re-persists it, clobbering every shell-computed degrade but the #3737 opt-out. The guard then denies the mandated sequential dispatch with `exit 2`. |
| #4561 | #4232's re-derivation fix reaches only producers whose degrade is re-derivable from a file the resolver reads. Three producers compute their degrade from call-site context that is **not on disk** and are structurally unreachable that way. |
| #4594 | `extractDispatchIdentifiers` cannot parse the canonical prompt-body dispatch text, so the sentinel match never succeeds. |

### What #4594 actually is, measured

The reported symptom is a greedy capture: `/execute\s+plan\s+(\S+)\s+of\s+phase\s+(\S+)/i`
swallows the `-{phase_name}` suffix and the sentence-terminating period, so
`Execute plan 02 of phase 03-auth.` yields phase `03-auth.` and can never equal the
sentinel's `03`.

That is true and incomplete. Running `phase-plan-index` against a real fixture shows
`plans[].id` is `03-02-hardening` — phase-prefixed, plan-numbered **and slugged** — and
`per-plan-worktree-gate.md:17` records exactly that value as the sentinel's `plan`. The
prose, meanwhile, carries a bare in-phase plan number (`02`). The two fields therefore live
in **different namespaces**, and the plan comparison mismatches on *every* dispatch, on
*both* hosts. The issue calls the Claude path "latent rather than dead"; it is dead too, for
a second reason the issue does not name. Fixing only the greedy capture would have shipped
as a green, fully-tested no-op.

### Why this recurs rather than staying fixed

Repairing each symptom where it was reported leaves the missing owner missing, and the next
occurrence is already being written elsewhere in the tree. The recurrence has a mechanical
root, and it is the same one ADR-2121 identified for phase identifiers: **a format with no
single owner is re-derived at each site, and two copies that agree today are the same defect
as two that disagree.**

## Decision

### Decision 1 — one module owns the emitted format *and* the parser that reads it back

`hooks/lib/dispatch-identity.js` owns both halves together:

- `renderDispatchIdentityMarker({phase, plan})` — the format producers emit.
- `parseDispatchIdentity(...texts)` — the pattern consumers read back.

Producers emit a structured marker carrying the **same shell values the sentinel records**:

```text
[gsd:dispatch phase="03" plan="03-02-hardening"]
```

`$PHASE_NUMBER` and `$plan_id` are already in scope at every producer site. Producer and
consumer then agree *by construction*, independently of how the surrounding prose reads or
whether a model paraphrases it.

The prose frame remains as a fallback, with the greedy `(\S+)` replaced by the phase-token
grammar ADR-2121 already owns, and with `plan` deliberately **not** reported — the prose
plan token is a different namespace from `plan_id`, and reporting it is the bug. The
fallback is therefore **correct-or-absent** in both fields: an absent identifier means
"cannot compare" and is safe by the existing contract; a wrong one is a false mismatch and
is not.

**The owner lives in `hooks/lib/`, not `src/`.** The guard hooks must load on a raw
plugin-marketplace install where the compiled `gsd-core/bin/lib/` is absent and the
self-healing build seam has not run — a hook that dies at module load is worse than one
carrying a mirror. A `src/*.cts` owner would force either a top-level require of the
compiled lib (breaking that install) or a second mirrored copy (the exact defect this epic
removes). Nothing in `src/**` needs this format: the producers are workflow *markdown* and
the consumers are *hooks*.

### Decision 2 — the isolation decision is a recorded fact, not a re-derived one

A producer writes an `IsolationDecision` (the value, which producer decided it, and its run
scope); consumers **read** it. A plain re-query must not overwrite a recorded decision.

Re-derivation is the wrong primitive for the three producers #4561 names, because each
computes its degrade from call-site context that does not exist on disk:

| Producer | Why re-derivation cannot reach it |
|---|---|
| `gsd-core/references/dispatch-isolation-gate.md` | the `orchestrator-worktree` fallback fires only at a subagent-tool-only dispatch site; the resolver cannot see which tool the caller has |
| `gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md` | the #2474 per-plan submodule intersection is a property of the plan set, not the repo |
| `gsd-core/workflows/execute-plan.md` | Pattern B's unisolated segments are by design; which segment is executing is not on disk |

**A decision that cannot be recomputed must be recorded and honoured, not recomputed and
overwritten.** #4232's base-check re-derivation stays — it is correct for the producers it
covers, and this decision builds on it rather than replacing it.

**The record states who decided it.** Holding and re-deriving are mutually exclusive on a
record that carries only the value and its scope. The degrade #4232 re-derives is itself
written as a fresh, in-scope `none` — so a hold keyed on value and freshness makes the
resolver hold its *own* previous answer, and #4232's "the evaluation reads live git state"
silently stops being true. Hold none of them and the three producers above are clobbered
again. The value cannot tell the two cases apart; only the producer can.

An `IsolationDecision` therefore carries a provenance field, `decided_by` in the sentinel
file (`decidedBy` once read), with exactly two values:

| `decided_by` | Written when | A later plain re-query |
|---|---|---|
| `resolver` | the resolver derived the value itself, from state it re-reads on every call — the #3737 opt-out, #4232's base check — including when either overrules a `--force-isolation` value | re-evaluates it; the record is not held |
| `caller` | a producer recorded it with `--force-isolation` (or `record-dispatch-isolation`), from a call site whose reasoning the resolver cannot reconstruct — the three producers in the table above — and the recorded value is the one it forced | holds it, when the record is fresh, well-formed, `none`, and in scope for the query |

**Provenance names the writer, not the kind of degrade.** `executor-isolation-dispatch.md` ends by
forcing the shell's final value (`--force-isolation "$ISOLATION"`), so a base-check `none` that
reaches that line is recorded as `caller` and held while it is fresh. That is deliberate. The
orchestrator has already committed to dispatching that run sequentially; if HEAD catching up
underneath it flipped the record back to `harness-worktree`, the guard would start refusing the
very dispatches the degrade mandated, which is #4222 in reverse. A gate that follows the hold
re-records the `none` and keeps its decision time, so the hold lapses ten minutes after the degrade
was decided, however many gates re-record it, and a forced record of another value replaces it
sooner. The next query that carries no `--plan` then re-derives the decision, base check included
(#4222). The guard runs a separate clock: it trusts a record for ten minutes from `written_at`,
falls back to resolving the host capability on a stale one (#3045), and keeps #5479's rule for an
aged `none` of its own phase, set out below.
Live re-evaluation governs the records the resolver writes itself: the plain-query path #4222 was
reported against (for the base check, the plain queries that carry no `--plan`). The hold is consulted on every plain query, including one that derives `none`
itself; writing that `none` as `resolver` would re-own the caller's record, and on a repository
where both degrades apply the caller's decision would be lost when HEAD caught up.

**A held decision is also the query's answer.** A plain query that holds a record prints its
`none`, with no `harnessFlag` or `exec`, and marks it `held: true` under `--json`, so the guard
and the workflow read one decision rather than two. A dispatch site therefore tells a held
`none` (follow it: run sequentially) from a host that declares no primitive (fail closed) by
that field. It still re-records its final `none`, at its own scope: the guard judges a
dispatch against the record present at that instant, and a held record can name another phase
or plan, or lapse before the site dispatches. That re-record must not renew the hold, or runs
started less than ten minutes apart keep a degrade alive indefinitely and it outlives the HEAD
divergence that caused it. So the record also carries `decided_at`, when the degrade was decided.
A held answer reports its `decidedAt`, and a site re-recording that `none` passes it back as
`--renew-held <decidedAt>`: the write refreshes `written_at` for the guard and records the
decision the site followed, so renewing does not extend the hold: it lapses ten minutes after that
decision. The time travels with the answer rather than being read from the file at write time,
which by then can hold another plan's record. A forced `none` without the flag is a new decision
with its own ten minutes, and the sites that decide one themselves (`execute-plan` Pattern B, the
gate's orchestrator-worktree fallback) keep a query naming no phase or plan at `none` while they
recur less than ten minutes apart.

Since [#5682](https://github.com/open-gsd/gsd-core/issues/5682) each dispatch also keeps its own
keyed record (`.gsd/dispatch-isolation/<phase>--<plan>.json`, or `<phase>.json` for a plan-less
decision), because a parallel orchestrator's write replaces the single legacy slot. The hold reads
the newest fresh record at the query's own scope: a plan query reads its own record, a phase query
reads its phase-level record and that phase's plan records, and either reads the legacy slot only
when it names that scope. Another orchestrator's later write can therefore neither hide the record
nor outrank it, unscoped writes included, which the guards count as applying to every dispatch. A
query naming neither a phase nor a plan has no keyed record to read: it reads the legacy slot,
whatever scope that carries, so it can hold another orchestrator's degrade and run sequentially for
the rest of that record's window. That is the safe direction, and it is bounded.

The hold reads by scope and the guard reads by recency, so the two can disagree, in two known ways.
A newer unscoped `harness-worktree` outranks a plan's `none` for the guard while that plan's own
query stays held, so the guard demands the harness flag. A plan stored as sequential gets past that
with its gate's forced re-record, which makes its record the newest again. Nothing atomic joins that
write to the dispatch, so another unscoped write between them blocks the dispatch, which fails
closed. A plan stored as `true` dispatches with the flag, and the guard allows it.

A plan that decides `true` within ten minutes of its own sequential decision is not held. The
per-plan gate's `true` branch reads the host's capability from `inspect-dispatch-isolation`, which
no hold reaches, and forces it at the plan's scope, so the record carries that capability and, on a
harness-worktree host, the guard demands the flag. It forces only when the plan id is non-empty: an empty id records at phase level, where the
override would reach every plan of the phase, so that case stays a plain query and is held as before.
A failed read, or a host that declares `none`, stays a plain query too. A plain query at the plan's
own scope still holds; records carry no run identity, so it cannot tell an earlier run's degrade from
this run's. For the same reason two runs sharing a plan id can cross: the force replaces a `none` the
other run recorded for that plan after this run decided `true`. That run's gate records `none` again
right before its own dispatch, and if the force lands between the two, a harness-worktree host's guard
refuses that dispatch, which fails closed.

Two windows apply, and they differ on purpose. The hold lapses ten minutes after `decided_at`. The
guard's trust in a fresh record lasts ten minutes from `written_at`, and it also honours an aged
`none` for its own phase for up to 24 hours (`AGED_NONE_MAX_MS`,
[#5479](https://github.com/open-gsd/gsd-core/issues/5479)), so a dispatch the hold no longer answers
for can still be allowed to run sequentially.

The host's *descriptors* — the harness flag and the orchestrator exec — are not
decisions and are read from `inspect-dispatch-isolation`, which records nothing and holds
nothing; read through the deciding query, a degrade recorded for one plan would answer for
another plan's dispatch.

**An absent field reads as `caller`**, and so does any value other than `resolver`. The
case this covers is a record written by a pre-Phase-2 `gsd-tools` still in flight during an
upgrade, and the default is chosen by the cost of being wrong in each direction: holding a
degrade that could have been re-derived costs one sequential run; clobbering one the caller
owns makes the guard refuse the dispatch outright, and the work does not run at all —
#4222's own worst case.

**What is re-derivable is not recorded.** The same rule settles the non-git project root,
whose base-check verdict #4734 changed after #4232 closed. A root with no repository has no
HEAD to compare against a fork base, so the base check has re-derived nothing there, and
that verdict is recomputed on every call. The resolver does not record it as a degrade; the
guard's #4734 fallback keeps owning it. The indeterminate `head-unresolvable` degrade is
still recorded, because failing closed on an indeterminate answer is #3050's rule.

**A plan-scoped write does not re-derive the base check.** A query that carries `--plan`,
even with an empty value, records the per-plan decision, and the base check is not one.
Execute-phase takes it at the phase-level resolve and again between waves (#1369), and a
degrade at either turns worktrees off for the rest of the run, so every later plan records a
forced `none`. A plan reaches the per-plan gate's `true` branch only when neither degraded.
HEAD can still move after that plan was decided: in a mixed wave a sequential plan commits on
the main tree before a worktree plan of the same wave dispatches, and a wave can merge back
while the between-wave check did not run. Re-deriving there would record `none` for a plan
decided `true`, so the guard would allow a dispatch of that plan without its harness flag.
The flag rather than its value is the test, because an empty `$plan_id` (lost with an earlier
tool call's shell) would otherwise record a `none` that names no plan, which the guard applies
to every plan of the phase. The #4561 hold reads the same empty value as no scope; the two
answer different questions, which scope a held record must match and whether this write is a
plan's record. Where the harness forks from `origin/HEAD`, a flagged dispatch on that base is
still stopped by the worktree branch check's `exit 42`, as it is without this decision. Every
unheld query that carries no `--plan`, at phase level or unscoped, still re-derives the base check. Its
residual is its own: one made mid-run after HEAD moved records `none` for the phase or the run,
and until the next record the guard reads it for every plan. No shipped flow dispatches against
it while its shell state is intact: execute-phase makes no such query after its resolve and
runs the base check itself between waves, and the one-shot flows (quick, quick-batch,
diagnose-issues, execute-plan) run the same check in shell and force its result before they
dispatch. The cost is a rule a future caller must know: a new plan-scoped plain query records
what the resolver derives without the base check (the host capability, or `none` under the
`use_worktrees` opt-out), and a hold still applies to it. If it needs the base check, it runs
that check in shell and forces the result, as the per-plan gate does for its submodule degrade.

**The hold is a read-then-write with no lock.** A plain query reads the records, decides whether to
hold, then writes. When it decided not to hold, a caller's forced `none` that lands between that read
and its decision write is overwritten by that write; a query that holds writes no decision. The writers take no lock, so the hold narrows the race with a plain query; it does not
close it.

**A held query refreshes executor identity, never the decision (amendment, #4904 review
2026-11-17).** Since #6220 the guards classify a dispatch as an executor dispatch by the executor
types recent records name (`isExecutorDispatch`). A held query writes no decision record, so those
names would stay as of the caller's write: a routed executor changed in the hold, another plan of a
held phase, the all-phase list of an unscoped query, a plan or `agent_hint` added in the hold, or a
record written without `--executor-type`. A flag-less specialist dispatch that `next` blocks with
`harness_flag_missing` would be allowed for the rest of the hold. So a held query writes the identity
it derives, and nothing else, to an executor-identity record:

- **Where.** `.gsd/dispatch-isolation-identity/`, a sibling of `.gsd/dispatch-isolation/`, never inside
  it: the keyed scan treats a file there that does not match its own phase/plan key as unusable and
  fails classification closed. The directory sits in the tool-owned `.gsd/` and is in its
  `.gitignore`; the writer refuses a linked record directory.
- **Key and merge rule.** One file per query scope: `plan+<phase>+<plan>.json`,
  `phase+<phase>.json`, or `all.json` for a query naming neither (`+` is outside the safe-key alphabet,
  so no two scopes share a name). On a case-insensitive volume two scopes whose keys differ only in case
  (`phase+A.json`, `phase+a.json`) are one file, as their keyed records are: the snapshot renamed last
  replaces the other, and a decision write for either spelling removes it. The replaced or removed
  snapshot's names leave the union until that scope's next held query, unless another recent record
  carries them. Phase and plan keys that differ only in case are not expected. Each write is a full snapshot of that scope's derivation, through an
  exclusive temp file and a rename, so a reader sees one whole snapshot. Two queries at the same scope
  race on the rename and the file holds the snapshot renamed last: a derivation that read the plans
  before an edit can replace one that read them after, until the next held query at that scope. The
  reader takes the union of every recent record's names, decision and identity alike; neither kind
  wins over the other.
- **When.** Only on a held query. An unheld query's decision record carries the same fields, so it
  writes none. Every decision write (an unheld or forced query, `record-dispatch-isolation`) removes
  its scope's identity record once the scope's keyed record landed, so the guards read that decision
  for the scope, as on `next` (`record-dispatch-isolation` carries only `--executor-type`, as it does
  there); a snapshot otherwise lasts until the next held query at its scope rewrites it or it ages
  out after 24 hours. A held query that cannot write its record still holds and writes no decision
  record: the caller's `none` stands, and the query says so on stderr. While a hold is possible (a
  record among those the reader reads meets the resolver's hold conditions: fresh, inside its ten
  minutes, `none`, decided by the caller), the reader fails classification closed (`scanOverflow`) in
  these states, each of which stops the write: that record's phase or plan is not a safe key (only the
  legacy slot can carry one, and the scope has no record name); a directory sits at a name in the
  writer's grammar (`all.json`, `phase+…`, `plan+…`), whatever its age; the identity directory, or with
  none `.gsd`, fails an access check for write and search; `.gsd/.gitignore` is a link (the tool-owned
  `.gsd` owner refuses to write). A linked or non-directory identity path was already overflow. A
  project with no hold-eligible record reads as before, whatever its `.gsd` permissions. Where an
  applicable `none` governs the dispatch, it still governs; the wider classification reaches
  dispatches no record applies to. Residual: a failure these checks cannot see (a transient I/O error
  such as a full or failing disk, an ACL or mount that an access check reads differently from a create)
  leaves the names as of the last write until the next held query records them. In each of the states
  above the fail-closed state lasts while any record the reader reads is hold-eligible, whatever its
  scope: it ends once none is, at the latest ten minutes after the latest such record's `decided_at`,
  and sooner when a decision write replaces that record. A linked, non-directory or unlistable identity
  directory is a scan overflow as well, which does not end with the hold. A prune failure after the
  record landed does not count as a failed write. An empty
  derivation (routing off, no hinted plans) is a valid snapshot and replaces the scope's previous one;
  a name another recent record carries still classifies.
- **Truncation.** The decision record's 64-name cap and its 4096-byte budget; names are dropped from
  the end, `executor_types_truncated` says so, the reader maps it to `executorTypesTruncated` and
  `isExecutorDispatch` fails closed. The held query's `--json` carries `executor_types_truncated` and
  its stderr the warning. The record carries no `decided_by` or `decided_at`, so its budget holds a
  few more names than the decision record's.
- **Hostile input.** A recent `.json` entry that is oversize, a link, a hard link, not a regular file,
  not JSON, of the wrong field types, stored under another scope's name, or stamped more than the
  clock-skew allowance in the future sets `scanOverflow`: classification fails closed, it does not
  ignore the record. A directory named `*.json` is skipped by the scan, as in the keyed scan; one at a
  name in the writer's grammar counts while a hold is possible (above). The scan has the keyed scan's bounds (1024
  entries, newest mtime first).
- **Reader.** `readSentinelAt` reads the records on its classify path only, in the shape
  `isExecutorDispatch` already consumes, so the two guard hooks are unchanged. Enforcement, the
  resolver's own-scope hold read and a `gsd-executor` dispatch never read them. The directory name,
  cap and budget are literals in `hooks/lib/isolation-sentinel.js`, pinned to their owner,
  `src/executor-type.cts`, by `tests/held-query-executor-identity.test.cjs`.

**A held query and a foreign dispatch (#6303).** A plan that declares `executor_runtime` resolves to
the target runtime's exec in `dispatch-isolation` (ADR-3711). A query that holds a caller's `none`
still resolves it: its stdout and `--json` carry the foreign dispatch, with `held: true`, and it writes
no decision record, so the caller's `none` stays that plan's record. Left there it would outlive the
hold: an aged `none` governs its own plan for 24 hours, so a flag-less spawn of that plan's executor
would be allowed where `next`'s foreign record, once stale, requires the flag. So the per-plan gate's
`true` branch forces the host's capability for every plan with a plan id, one that goes to another
runtime included. The force makes that query's own answer a `forced_isolation` fallback, but the gate
passes on its plain answer, so the plan still goes to its runtime, and the orchestrator-worktree exec
read, which a non-`none` record does not hold, records `next`'s foreign decision.
`inspect-dispatch-isolation --json` reports `held: false` and
`decidedAt: null` beside `executorRuntime: null` and `fallback: null`, so the two verbs keep one key
set. The orchestrator-worktree exec read names its plan, as #6303 requires, so a hold reaches it only
through that plan's own caller `none`, which the gate has replaced unless a caller records a new one in
between; a held host answer there is `exec: null` and halts the wave.

### Decision 3 — a copy that must exist is pinned by a parity test, never merely tolerated

Decision 1's cold-load constraint means `hooks/lib/` carries deliberate mirrors of two
things it cannot import: the phase-token grammar (from `src/phase-id.cts`) and the isolation
vocabulary (from the Phase 2 owner). Each mirror is **pinned by a parity assertion that reds
when the owner changes**.

This matters more than it looks. A drifted grammar mirror fails as a **non-match** — nothing
throws, no test that only feeds the old shape notices, and the symptom is a guard that
quietly stops recognizing valid input. That is the failure mode that produced #4594 and it
is invisible without a pin.

The same holds outside `hooks/lib/`. The dispatch sites and diagnostics validate the resolver's
output in shell (`case "$ISOLATION" in harness-worktree|orchestrator-worktree|none) ;;`), and shell
inside workflow markdown cannot import the owner at all. Each such list is pinned to the owner by a
parity test that discovers the lists by scanning `gsd-core/**/*.md`, so a new copy naming a worktree
mode is pinned the day it lands.

A mirror's justification is part of the contract: **do not "clean up" a pinned mirror
without replacing the reason it exists.**

### Decision 4 — the anti-divergence lint is part of the deliverable, not a follow-up

A drift lint asserts that (a) every dispatch-identifier template in
`gsd-core/workflows/**/*.md` and every parsing regex in `hooks/**` derives from the single
exported token source, and (b) every dispatch-isolation producer site appears in the
canonical membership list. It is modelled on `scripts/lint-phase-id-drift.cjs`.

Two lessons from #2121 are binding:

- Compare the regex derived from the **source string** (`.source` / `.flags` against the
  canonical token), not the rendered literal.
- A sanctioned exemption is a **dedicated comment line** that states which half is
  deliberate — never a line-level substring escape. Partial ownership is drift, and a
  line-level escape waves through exactly the case under review.

Decisions 1 and 2 without Decision 4 un-consolidate quietly as soon as someone who has not
read this ADR touches the area. **The lint must be demonstrated red before it is
demonstrated green** — a drift guard that has never failed is not evidence.

### Decision 5 — an inapplicable sentinel is reported, never silently discarded

When a fresh sentinel exists but does not apply to a dispatch, the guard states so in its
deny reason and names both sides' identifiers.

This is Postel's Law's "be liberal but *visible*" half, and its absence is why the defect
survived three producers and two consumers unnoticed: the guard discarded a fresh sentinel
and then denied with a message about registry resolution that never mentioned the sentinel
existed. Values interpolated into that message come from a sentinel file and from
model-authored prompt text — both untrusted — so each is length-bounded and stripped of
control characters first, matching the escaping discipline `phase-plan-index` already
applies to a `depends_on` token.

## Alternatives rejected

1. **Repair the three absorbed issues at their existing call sites.** This is the pattern
   that produced them. It leaves the epic open with every symptom gone and CI green — the
   specific outcome the epic's scoping exists to prevent.
2. **Normalize the plan comparison** — strip the phase prefix and slug and compare the
   middle segment. Invents a cross-namespace equivalence no producer guarantees, and
   silently restores wrong-value-instead-of-no-value the moment plan-id naming changes.
   Returning `null` is honest; a heuristic match is not.
3. **Carry a structured per-dispatch kwarg through the Agent/Task protocol.** This is the
   correct end state and `hooks/lib/isolation-sentinel.js` has named it as such since #3045.
   Rejected *for now* under Gall's Law: it is a 19-runtime descriptor change and an
   ADR-1239-level negotiation change. The marker is the simple version that works, and
   growing one into the other is the sanctioned path.
4. **Own the format in `src/dispatch-identity.cts`.** Breaks the cold-tree hook load
   contract, or forces the second mirror this epic exists to delete.
5. **Delete `sentinelAppliesToDispatch`'s plan/phase narrowing**, on the grounds that it has
   never worked so removing it changes nothing observable. It is #3045 SECURITY F2's defence
   against a stale sentinel from an earlier phase authorizing a later dispatch. The marker
   makes it work for the first time; deleting it would trade one silent hole for another.

## Consequences

**Accepted cost.** `[gsd:dispatch k="v"]` is a homegrown key/value mini-syntax, and
Greenspun's Tenth Rule is the standing warning against letting one grow. It is therefore
deliberately inert: exactly two recognized keys, flat, no nesting, no conditionals, no
variables, no escaping rules beyond quoted values, and unrecognized keys ignored so a later
addition cannot break a deployed parser. **Revisit condition, stated so it is actionable:
the moment this marker needs a third semantic key or any structure, stop and implement
alternative 3 instead.**

**Accepted limit.** The marker is emitted by a model following a template on BOTH paths —
the harness path AND the orchestrator-worktree path. Per
`executor-isolation-dispatch.md:131`, the orchestrator-worktree path's `{plan_number}` and
`{phase_number}` "are template placeholders, not shell variables," and `{plan_id}` is
model-substituted there exactly as on the harness path — there is no shell-built prompt on
either path, so the marker is NOT guaranteed on either. A model that drops it degrades to
the prose fallback everywhere. That fallback is now correct-or-absent, which is sufficient
to resolve #4594 on the phase field alone, but plan-level scoping is exact only when the
marker survives. The prose fallback is therefore the real floor on both paths.

**Hyrum's Law constraint.** The prose sentence `Execute plan X of phase Y` is read by the
executor agent itself, not only by the guards. It stays **byte-identical**; the marker is
purely additive. Any future change to that sentence is a behavior change to every executor
dispatch, not a formatting edit.

**Out of scope.** The sentinel remains a `cwd`-derived, gitignored file; #3045 SECURITY F3's
accepted forgery risk is unchanged. This ADR changes how the decision is transported, not
when a degrade should occur.

## Phase mapping

| Phase | Delivers | Decisions |
|---|---|---|
| 1 | `hooks/lib/dispatch-identity.js`; producers emit the marker; both guards parse through the owner; #4594 regression | 1, 3 (grammar mirror), 5 |
| 2 | Isolation-vocabulary owner; recorded `IsolationDecision` that a re-query holds; #4222 / #4561 regressions | 2, 3 (vocabulary mirror) |
| 3 | `scripts/lint-dispatch-identity-drift.cjs`, demonstrated red then green | 4 |

Each deliverable is claimed by exactly one phase. The epic stays open until Phase 3 lands.

Phase 3 ([#6027](https://github.com/open-gsd/gsd-core/issues/6027)) landed as `scripts/lint-dispatch-identity-drift.cjs`, run by `npm run lint:ci` (also `npm run check:dispatch-identity-drift`). It checks three things: every `[gsd:dispatch …]` marker in `gsd-core/workflows/**` and `gsd-core/references/**` round-trips through the owner; no `hooks/**` regex parses dispatch text outside the owner without a dedicated `// dispatch-identity-owner: <reason>` line above it; and the markdown files holding a `--force-isolation` producer equal `PRODUCER_SITES` in the lint script, in both directions. Adding a producer means adding it to that list on purpose.
