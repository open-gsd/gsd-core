# How to handle gate verb exit statuses in a script

**Goal:** Call a gate verb from a shell script or workflow step and act on what it found, so that a failing verdict stops your pipeline and a gate that could not read its evidence is never mistaken for "nothing to report".

**Prerequisites:** A script that runs `gsd-tools` (in a workflow, through `gsd_run`). It runs under `set -e`, or you want it to be safe to. For why the statuses are shaped this way, see [Gate Evidence and Verdict-Driven Exit Status](../FEATURES.md#5170-gate-evidence-and-verdict-driven-exit-status).

The examples call `gsd_run`, which every workflow preamble defines. In a plain shell, define `gsd_run() { node /path/to/gsd-core/bin/gsd-tools.cjs "$@"; }`.

---

## Capture the status, then branch

Capture stdout and the exit status in one line. The `&& … || …` form never trips `set -e`, and it keeps the real status in `$V_EXIT`, which an `if` or a bare `$(...)` would discard:

```bash
OUT=$(gsd_run verify artifacts "$PLAN") && V_EXIT=0 || V_EXIT=$?
case "$V_EXIT" in
  0|1) ;;                                   # a verdict was delivered: read $OUT
  66)  echo "plan declares no artifacts" ;; # read, nothing to verify
  *)   echo "could not run (exit $V_EXIT): $OUT" >&2; exit 1 ;;
esac
```

Run against a plan whose artifacts all pass, this printed `V_EXIT=0` and, reading `.all_passed` from `$OUT`, `true`.

A bare call under `set -e` aborts the script on the first non-zero status, before you can read the JSON. With a missing plan it exited `69` and never reached the next line. Do not write `gsd_run verify … || true`, and do not follow the call with `&& echo ok || echo failed`: both discard the status.

---

## Decide what each status means

| Exit | stdout | Meaning | What to do |
|---|---|---|---|
| `0` | JSON | Positive verdict (status mode), or any delivered verdict (payload mode) | Continue. In payload mode read `.block` from the JSON to decide whether to stop |
| `1` | JSON | Negative verdict (status mode): `all_passed` / `valid` / `complete` / `passed` is `false` | Read the JSON for what failed and take your blocked branch. This is an answer, not a crash |
| `1` | empty (message on stderr) | `error()`: the command failed (for example `phase uat-passed 99` on a phase that does not exist) | Treat as could not run |
| `66` | JSON with an `error` text | The evidence was read and its scope is genuinely empty (`verify artifacts` / `key-links` with no block, or an empty plan file) | Usually fine to skip; decide per verb |
| `69` | JSON | The gate could not look | Stop. Never treat as clean and never as "no findings" |
| other | any | `64` usage, `70` internal | Could not run |

Which mode a verb is in decides whether a blocking verdict is `1` or `0`. Status mode: `phase uat-passed`, `verify artifacts`, `plan-structure`, `phase-completeness`, `references`, `commits`, `key-links`. Payload mode: every `check <verb>`, `verify schema-drift`, `verify codebase-drift` and `verify context-drift` (a blocking verdict is exit `0` with `"block": true`). The full table is in [Gate verb exit statuses](../CLI-TOOLS.md#gate-verb-exit-statuses-5170).

For `phase uat-passed`, empty stdout is how you tell `error()` from a failing verdict:

```bash
OUT=$(gsd_run phase uat-passed "$PHASE" 2>/dev/null) && U_EXIT=0 || U_EXIT=$?
if [ "$U_EXIT" -eq 1 ] && [ -z "$OUT" ]; then echo "could not evaluate phase" >&2; exit 1; fi
```

On a phase that does not exist this gave `U_EXIT=1` with a zero-length `$OUT`; on a phase with no UAT files it gave `1` with the JSON (`"passed": false`, `"no_uat_artifacts": true`).

---

## Tell "nothing to report" from "could not look"

A gate can end three ways when it has nothing to flag. Only the first is clean:

- **Looked and found nothing.** Exit `0`, a passing payload (`"passed": true`, `"all_passed": true`).
- **Looked at an empty scope.** Exit `66` (status mode), or exit `0` in payload mode with the gate's own skip message.
- **Could not look.** Exit `69`. The payload says why, in whichever of these fields the verb carries:

| Payload | Cause |
|---|---|
| `"error": "File not found"` | the plan or document path does not exist |
| `"error": "File unreadable"`, `"read_error": "EISDIR"` | the path exists but cannot be read as a file; `EACCES` and `EIO` are reported the same way |
| `"error": "Phase not found"` | the phase argument did not resolve |
| `"error": "Not a git repository"` | `verify commits` outside a git work tree |
| `"status": "unresolvable"` with `readError` | a `check verify-command-paths` / `verify-failure-directions` probe could not resolve its phase |
| `"scopeStatus": "unresolvable"` with `scopeReason` | `check ui-safety-gate` could not establish its evaluation scope |
| `scope_read_error` / `documents_unreadable` | a plan scan did not see every plan (an unreadable nested `plans/`), or a codebase-map document could not be read |

Run in a directory that is not a git work tree, the probe produced exit `69`:

```bash
OUT=$(gsd_run check ui-safety-gate 99) && C_EXIT=0 || C_EXIT=$?
# C_EXIT=69; OUT has "scopeStatus": "unresolvable", "scopeReason": "git-failed:rev-parse", "block": false
```

Note `"block": false` beside exit `69`: the gate's blocking policy is unchanged, so do not read `.block` alone. Check the status first.

---

## Wire it into the dispatch contract

`check <verb>` gates are dispatched in two steps: step 1 runs the command, step 2 reads `.block` from stdout. A non-zero status is a step-1 command failure, and the hook's `onError` decides what happens (`skip` continues as non-blocking, `halt` surfaces the error and stops). That is why a blocking `check` verdict exits `0`, and why `69` is the status that reaches `onError`: a gate that could not look is a command failure, not a verdict.

If you write a new gate or wire an existing one into a capability, declare `onError: halt` on its hook when a gate that could not look must stop the run. A `blocking: true, onError: skip` hook drops a `69` and continues, which is the silent pass this contract exists to prevent. Never call `exit 1` yourself to signal a blocking verdict from a `check` verb: the dispatch would read it as a skippable command failure.

---

## Related

- [Gate Evidence and Verdict-Driven Exit Status](../FEATURES.md#5170-gate-evidence-and-verdict-driven-exit-status) — why unreadable evidence is a distinct state and why the exit follows the verdict
- [Gate verb exit statuses](../CLI-TOOLS.md#gate-verb-exit-statuses-5170) — verb-by-verb table
- [Exit code reference](../reference/exit-codes.md) — the registered codes
- [Adopt the v2 exit contract](adopt-the-v2-exit-contract.md) — the separate `DEGRADED` projection
- [docs index](../README.md)
