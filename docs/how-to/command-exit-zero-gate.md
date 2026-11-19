# How-to: add a `command-exit-zero` gate to a capability

> **Diátaxis quadrant:** How-To. A step-by-step recipe for a capability author
> who wants a gate that runs a shell command and blocks the loop on non-zero
> exit. For the full specification, see
> [Reference: gate predicates](../reference/gate-predicates.md).

## When to use this

Use a `command-exit-zero` gate when your capability can be verified by an
existing command-line check — a test runner, a linter, a custom validator, a
git-hook-style probe. The gate runs your command at a loop point you choose and
blocks the loop (advisory or hard) when it exits non-zero.

This is the generic extension path introduced in #2008 / ADR-2008. Before it,
only built-in `check.query` gates could fire; a third-party capability's
declared gate was display-only.

## Prerequisites

- A capability with a `capability.json` (see ADR-0894).
- A command that exits `0` on success and non-zero on failure, runnable via
  `sh`. On Windows, `sh` must be present (git-bash / WSL) — otherwise the gate
  fails closed with exit 127.

## Step 1 — author the command

Write a command that follows the **exit-0-on-success** contract. It receives
the project root as its cwd and the inherited process environment.

```bash
# Example: a bundled check script shipped with the capability
node "${GSD_CAP_DIR}/checks/pre-ship.js"
```

The command can read three loop-context environment variables. Write each one in plain double quotes (`"${GSD_PHASE_DIR}"`). A use that is not provably in plain double quotes reports `unevaluable`; assign the value to a variable first and double-quote every use of that variable. The same holds for a use inside the text that `eval`, `trap` or `sh -c` parses again: read the variable there from the environment in single quotes (`sh -c 'test -d "$GSD_PHASE_DIR"'`; the check reads that text on its own, so `$GSD_PHASE_DIR` without double quotes inside it is refused), pass the value as an argument (`sh -c 'test -d "$1"' sh "${GSD_PHASE_DIR}"`) or write `$d` in single quotes. A command that runs `xargs` without a delimiter option (`-0`, `-d`, `--null` or `--delimiter`) is refused for any use, because `xargs` splits and unquotes its input. [gate-predicates](../reference/gate-predicates.md) lists the refused forms and shows the rewrites. The old names `PHASE_NUMBER`, `PHASE_DIR` and `PHASE_REQ_IDS` are no longer set. A command that writes one in the braced form (`${PHASE_DIR}`) is refused, and the message names the replacement. A bare `$PHASE_DIR` is the gate's own shell variable and runs. Migration: `'${PHASE_NUMBER}'` becomes `"${GSD_PHASE_NUMBER}"`.

| Variable | Meaning |
|---|---|
| `GSD_PHASE_NUMBER` | the active phase number (e.g. `03`) |
| `GSD_PHASE_DIR` | the active phase directory |
| `GSD_PHASE_REQ_IDS` | the phase's requirement ids |

Anything else (`${HOME}`, `$VAR`, etc.) is left for `sh` to interpret against
the inherited env.

## Step 2 — declare the gate

Add a `gates` entry to your `capability.json`. Pick the loop `point` (one of
the 12 canonical points), set `blocking` and `onError`, and gate it on a
config key with `when`:

```json
{
  "gates": [
    {
      "point": "ship:pre",
      "check": {
        "predicate": {
          "kind": "command-exit-zero",
          "command": "node \"${GSD_CAP_DIR}/checks/pre-ship.js\" \"${GSD_PHASE_DIR}\"",
          "timeout": 30
        }
      },
      "when": "my_cap.enabled",
      "blocking": true,
      "onError": "halt"
    }
  ]
}
```

Field rules (enforced by the evaluator):

- `predicate.command` — required, non-empty string, ≤ 4096 chars.
- `predicate.timeout` — optional, positive finite number of seconds (default 30).
- `predicate.kind` — must be exactly `"command-exit-zero"`.

## Step 3 — choose `blocking` and `onError`

| Field | Effect |
|---|---|
| `blocking: true` | A `block: true` result **halts** the loop at this point. |
| `blocking: false` | Advisory — the gate prints its `message` and the loop continues. |
| `onError: "halt"` | If the check command itself fails (malformed predicate, unknown kind, or a command that cannot be evaluated), halt. |
| `onError: "skip"` | On a check-command failure, warn and continue (do not read `block`). |

> A non-zero exit of **your** command is a gate *result* (`block: true`), not a
> check-command failure — `onError` does not apply to it. `onError` covers only
> the case where the gate could not be evaluated at all.

## Step 4 — test the gate directly

You can run the evaluator standalone to verify your predicate before wiring it
into a loop point:

```bash
gsd_run check predicate \
  --predicate '{"kind":"command-exit-zero","command":"node checks/pre-ship.js \"${GSD_PHASE_DIR}\"","timeout":30}' \
  --phase-dir ".planning/phases/03-my-phase" \
  --phase-number "03" \
  --raw
```

Expected output on success:

```json
{ "block": false, "message": "command exited 0", "details": { "kind": "command-exit-zero", "exitCode": 0 } }
```

Expected output when your command fails (e.g. exit 1):

```json
{ "block": true, "message": "command exited 1: <stderr tail>", "details": { "kind": "command-exit-zero", "exitCode": 1, "signal": null } }
```

## Step 5 — verify it fires in the loop

Once declared and the capability is active, the loop-resolver renders the gate
at your chosen point. The workflow gate-dispatch (`execute:wave:post`,
`execute:post`, `plan:post`, `ship:pre`, …) detects the `predicate` shape and
dispatches the evaluator automatically — no further wiring needed.

```bash
gsd_run loop render-hooks ship:pre --raw
```

A blocking `ship:pre` predicate gate (except `security` and `broken-windows`,
which `ship.md` enforces itself) also guards the milestone close:
`milestone complete --confirm` re-checks it once per milestone phase when the phases are readable (with
`${GSD_PHASE_NUMBER}`/`${GSD_PHASE_DIR}` set to that phase) and refuses while it
blocks; when they cannot be read, only an `onError: halt` gate refuses (one
block) and the others warn. `--force` does not bypass it, and `--dry-run` runs it
too: `would_refuse` lists every gate the close would refuse on, and
`gate_warnings` lists gates skipped without refusing, so an empty `would_refuse`
with a non-empty `gate_warnings` is not "no open work". Your command therefore
runs again at close, once per phase, so keep it read-only and idempotent.

## Gotchas

- **Backgrounded children escape the timeout.** `command: "sleep 100 &"` returns
  before the sleep finishes; the timeout kills the `sh` parent, not the
  backgrounded child. Keep your command foreground, or have it self-manage its
  children. (ADR-2008, documented limitation.)
- **`sh` must be on PATH.** On Windows without git-bash/WSL, the gate fails
  closed (exit 127). This matches the runtime's existing bash dependency.
- **Output is trimmed.** The whole gate `message` (including the
  `command exited N:` prefix) is capped at 2000 chars; for stderr/stdout the
  last chars are kept. A timeout with empty or whitespace-only stderr shows the head of the
  command instead. Emit a concise diagnostic; don't rely on grepping long output
  downstream.
- **Env is inherited.** The command sees the full GSD process environment. Do
  not put secrets in the command string; read them from env or a file like any
  shell script.

## Related

- [Reference: gate predicates](../reference/gate-predicates.md)
- [ADR-2008](../adr/2008-command-exit-zero-gate.md)
