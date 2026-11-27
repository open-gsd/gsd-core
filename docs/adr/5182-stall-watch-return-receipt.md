# ADR-5182: A plan-phase return receipt holds the agent's complete return

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-11-24 |
| **Issue** | [#5182](https://github.com/open-gsd/gsd-core/issues/5182) (the stall watch never observes real completion); implemented by [#6661](https://github.com/open-gsd/gsd-core/pull/6661), which takes over [#5192](https://github.com/open-gsd/gsd-core/pull/5192) |
| **Supersedes** | — |
| **Amends** | — |
| **Constrained by** | the maintainer rulings on #5182 of 2026-11-05 (the checker writes its receipt through its shell and declares no write grant; the generated Pi copies stay; step 11a's receipt-without-body route stays) and the amended acceptance criterion 5 ("wherever the agent's shell can write its receipt") |

> **Status note.** `Proposed` until the owner ratifies it. The decision is the owner's, taken in chat on 2026-11-24 after the implementing agent had chosen a different design on its own and was asked to measure first (see Alternatives).

## Context

`/gsd:plan-phase` waits for its background planner, plan-checker and revision spawns with `gsd_stall_watch` (#2650). On `next` that watch grepped the host's `{outputFile}` for the return markers. On Claude Code that file is the subagent transcript, which already holds the agent's prompt and definition snapshot, and both quote the markers, so the wait reported `marker_received` at its first check whether or not the agent had returned; the marker-less revision watch could only end `stalled`; and a host with no output file could only ever reach `stalled` (#5182).

#5192 replaced the transcript with a GSD-owned, per-dispatch return receipt, written by the agent as its last tool action. That receipt held only the marker line. The agent writes it before its final message, so a watch that read it learned that an agent was finishing, not what it returned. The routes that need the body (step 11 reads a PASSED body for listed findings; 9b, 9c and the revision conflict record read theirs) then met "marker, no body" on a normal return and fell into the Retry-first menus of 9a/11a. The author of #5192 found this four times in their own reviews, tried "wait one more interval for the body" in prose, and found that each wording fix exposed another route that reads "when the watch ends"; they handed the design back on 2026-11-22.

## Decision

The receipt holds the agent's **complete return**, so a receipt that exists is a return that has arrived.

1. **Content.** The first line is the return marker; the rest is everything the agent returns, word for word. The agent's final message still carries the same return, so the host's completion result stays a working fallback and an agent definition installed before this change keeps working.
2. **Atomic write.** The agent's last tool action is one Bash call: `cat > 'PATH.part' <<'GSD_RETURN_END_7f3c9a1e' && mv -f 'PATH.part' 'PATH'`. The rename means the receipt never exists half-written, a failed `cat` publishes nothing, and nothing reads a `.part` file. The snippet lives once per agent definition (planner, checker; the Pi copies are generated) and a test runs it under bash and zsh. The checker still declares no write grant; the planner already holds Bash.
3. **Reader.** `gsd_return_body FILE` prints the receipt. It prints nothing for a symlink, a directory, a missing or unreadable file, an empty file, a file with a NUL byte anywhere, or a file over 65536 bytes. An oversize return counts as no body and the body-needing routes fail closed, because a cut body could drop a finding.
4. **Routing.** On `marker_received` the orchestrator routes on `gsd_return_body "{receipt}"` and does not wait for the completion result. The rule is stated once, in step 7.99 of `plan-phase.md` and in `stall-detection-helpers.md`, which every route inherits. If the completion result arrives first or between cycles, whichever of the two ends the wait routes it, and two different markers count as an unrecognized return (9a/11a), as before.
5. **Marker-only receipts.** A receipt holding only the marker (an agent definition installed before this change) keeps the existing 9a/11a body-less routes. They now describe a real gap and never a race, which is the sense in which the 2026-11-05 ruling keeps 11a.
6. **Unchanged.** `gsd_receipt_path` and its input contract, symlink walk and `.gitignore` check; `gsd_return_marker` and its start-of-line matching; the glob rewrite of the artifact watch; `gsd_stall_should_recover`.

## Alternatives considered

- **A settle window** (the first fix, built by the implementing agent without asking): a receipt younger than 120 seconds makes the watch sleep out the rest of the window in the same call, then report. Rejected by the owner. It bounds the race with a guess: on two real background checker runs the final message arrived within about 5 seconds of the receipt, but the planner and revision spawns were not measured, delivery during one long `sleep` was untested, and the call sits inside a Bash call that issue #6409 says Claude Code already pushes to the background past 120 seconds.
- **A two-signal rule** (a receipt alone never routes; wait for the completion result too): no timing constant and no agent change, but up to one extra poll interval, so acceptance criterion 3 (a finished revision is reported within one poll interval) is not met, and it must be restated on every route that reads "when the watch ends", which is the shape the author could not make hold.
- **A receipt used only as liveness** (completion from the host's completion result only): the race cannot occur, but a checker that passes quickly looks silent until its completion result is processed, a lost completion result is caught only at the stall threshold, and it drops the 2026-11-05 ruling that the receipt carries the marker.
- **Putting only the body location in the final message**: rejected so that the final message keeps working for the host's own completion path and for mixed installs.

## Consequences

- The race is removed by construction rather than bounded. No timing constant exists.
- A watched agent writes its return twice (the receipt, then the final message); the return contracts cap a return at a few dozen lines.
- The planner's receipt write moves from the `Write` tool to Bash (it already holds Bash and commits its plans through it); the checker still writes through its shell.
- Hosts whose sandbox refuses the shell write (Codex `read-only`, kimi-code) still produce no receipt and end on the completion result or `stalled`, as before; that gap stays tracked in #6110.
- The measurement behind the decision is thin and recorded as such: two checker runs, planner and revision unmeasured. The design does not depend on those numbers.
- `plan-phase.md` is at 98,296 of its 98,300-byte pin, so the routing rule lives in the helper document and one sentence of step 7.99 rather than repeated in steps 9, 11 and 12.

## Verification

`tests/plan-phase-stall-detection.test.cjs` pins `gsd_return_body` (byte-for-byte body, the 64 KiB cap at limit-1, limit and limit+1, nothing for a link, a NUL, a directory, a missing or an empty file, and a fast-check property), the documented write snippet in the planner, the checker and their Pi copies run under bash and zsh (atomic, complete, a failed write publishes nothing), a `.part` file never read as a receipt, a marker-only receipt, step 7.99 routing on the body, and the wording of the docs, the changeset and `CONTEXT.md`. The new rows failed on the previous design (`gsd-test` on `9cc30463f3b2b7b874704cadf5b92455518c2927`, 9 failures) and pass on the head.
