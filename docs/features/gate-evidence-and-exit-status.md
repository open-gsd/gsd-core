---
id: 5170
title: Gate Evidence and Verdict-Driven Exit Status
group: v1.7.0 Features
---

**Purpose:** A gate that could not read its evidence used to behave exactly like a gate that read it and found nothing. A phase directory that failed to list, a plan that was a directory, an unreadable `COVERAGE.md` or a nested `plans/` that errored all collapsed to an empty string, an empty list or `false`, and the gate passed over content it never saw. Separately, the exit code was chosen verb by verb: `phase uat-passed` and `verify artifacts` printed a failing verdict and exited `0`, so a script that branched on `$?` shipped a failed phase (#4686). This is the third and fourth bullet of [ADR-5057](adr/5057-one-owner-per-workflow-verdict.md) §4 (epic #5056, #5170).

**Behavior:**

- **Unreadable is a distinct state from none.** A gate reads evidence as `found` (a value; an empty file is `found ''`), `none` (the thing authoritatively does not exist: `ENOENT`, or `ENOTDIR` because a parent is a file) or `unreadable` (it exists or may exist and could not be read: `EISDIR`, `EACCES`, `EIO`, an encoding failure, an unresolvable phase, a plan scan that did not see every plan). `none` is a legitimate answer and each gate keeps its documented policy for it; `unreadable` is never coerced to `''`, `false` or an empty list. The verdict builder for the `unreadable` arm returns a verdict typed `outcome: 'unreadable'`, so a passing verdict from that arm does not type-check. A drift guard (`lint-gate-evidence-drift`) rejects the remaining shapes the type cannot see: an empty `catch` in a gate, a tolerant reader that returns `''`, a verdict arm that passes from `unreadable`, and a gate verb that sets its own exit code.
- **The exit code is a function of the verdict.** One total function maps the outcome to a registered code: positive verdicts `0`; a negative verdict `1` in status mode; a read-and-genuinely-empty scope `66` (`NO_INPUT`); `unreadable` `69` (`UNAVAILABLE`) in both modes. No verb picks a code. The gate's own `block` decision is untouched: policy did not change, only the outcome and the exit for the unreadable arms.
- **Status mode and payload mode.** `phase uat-passed` and the `verify` verbs that shell callers branch on (`artifacts`, `plan-structure`, `phase-completeness`, `references`, `commits`, `key-links`) are status mode: exit `1` is a negative verdict and the JSON on stdout is still the verdict. The gates that are routed as `check <verb>`, and the three drift verbs, are payload mode.
- **Why `check` verbs stay payload mode.** The gate dispatch (`execute-phase/steps/wave-post-gate-hooks.md` step 1, `references/loop-hook-dispatch.md`) reads `.block` from stdout and treats a non-zero exit as a command failure routed by the capability's `onError`. `capabilities/drift` declares schema-drift `blocking: true, onError: skip`; exit `1` for "blocked" would be dropped as a skippable failure. A blocking verdict is therefore a delivered answer and exits `0`; only "could not look" exits `69`, which the dispatch routes as a step-1 command failure.
- **Callers are migrated.** The workflow and agent shell blocks that consume these verbs capture the status (`… && X_EXIT=0 || X_EXIT=$?`, safe under `set -e`), read the JSON for `0`, `1` and `66`, and treat `69` or anything else as "could not run". Fail-closed consumers (the safe-resume and TDD gates) halt with a message that is not "missing RED commit".

**Declared behavior changes:**

- `verify schema-drift` reads `files_modified` through the Frontmatter Module: a YAML block sequence and CRLF files now yield their files (#4562); before, only the inline array was seen and such a plan reported no drift.
- `verify plan-structure` flags a `! grep -q 'LIT' f` negative gate whose literal also appears in the same task `<action>` (#4541).
- A plan that exists but is empty is read: `verify artifacts` / `verify key-links` exit `66` instead of `File not found`; `verify plan-structure` reports it invalid (`1`).
- `verify commits` outside a git work tree answers `{"error":"Not a git repository"}` with `69` instead of listing every hash as invalid.
- `scripts/run-tests.cjs` fails a chunk whose registered tests exceed its reported results, or whose accounting inputs are missing; it no longer drops executed tests under `--test-force-exit` (#4031).

**Known limits:** `checkUiPresence` is a vocabulary check over prose and reads nothing; it stays outside the evidence type. Gates whose accepted-evidence model is narrower than GSD's producers (#4692, #4867, #4957) are out of scope.

**Reference:** [Gate verb exit statuses](CLI-TOOLS.md#gate-verb-exit-statuses-5170) · [Exit code reference](reference/exit-codes.md) · [Handle gate verb exit statuses](how-to/handle-gate-verb-exit-statuses.md)
