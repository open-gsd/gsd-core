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

Read loop context from the namespaced environment variables provided to the
child. Quote their shell expansion so each value is passed as literal data:

| Environment variable | Meaning |
|---|---|
| `GSD_GATE_PHASE_NUMBER` | the active phase number (e.g. `03`) |
| `GSD_GATE_PHASE_DIR` | the resolved absolute phase directory |
| `GSD_GATE_PHASE_REQ_IDS` | the phase's requirement ids |

For example, `node checks/pre-ship.js "$GSD_GATE_PHASE_DIR"` passes the directory
as one argument even if its name contains spaces, quotes, backticks or `$(...)`.
GSD never rewrites the command text. Missing phase values are empty strings and
override any inherited variables with these names. Other variables (`${HOME}`,
`$VAR`, etc.) remain available through the inherited environment.

Existing manifests using `${PHASE_NUMBER}`, `${PHASE_DIR}` or `${PHASE_REQ_IDS}`
must migrate to the corresponding quoted shell expansions above. The old
spellings are rejected before the command runs, with the replacement named in
the diagnostic. See the [ADR-2008 amendment](../adr/2008-command-exit-zero-gate.md#amendment--2026-10-14-phase-context-is-environment-data).

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
          "command": "node \"${GSD_CAP_DIR}/checks/pre-ship.js\" \"$GSD_GATE_PHASE_DIR\"",
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
  --predicate '{"kind":"command-exit-zero","command":"node checks/pre-ship.js \"$GSD_GATE_PHASE_DIR\"","timeout":30}' \
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

## Gotchas

- **Backgrounded children escape the timeout.** `command: "sleep 100 &"` returns
  before the sleep finishes; the timeout kills the `sh` parent, not the
  backgrounded child. Keep your command foreground, or have it self-manage its
  children. (ADR-2008, documented limitation.)
- **`sh` must be on PATH.** On Windows without git-bash/WSL, the gate fails
  closed (exit 127). This matches the runtime's existing bash dependency.
- **Output is trimmed.** Only the last 2000 chars of stderr/stdout surface in
  the gate `message`. Emit a concise diagnostic; don't rely on grepping long
  output downstream.
- **Env is inherited with phase context overridden.** The three `GSD_GATE_PHASE_*`
  variables always reflect this invocation, including empty values. Do
  not put secrets in the command string; read them from env or a file like any
  shell script.

## Related

- [Reference: gate predicates](../reference/gate-predicates.md)
- [ADR-2008](../adr/2008-command-exit-zero-gate.md)
