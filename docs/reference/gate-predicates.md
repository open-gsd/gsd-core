# Gate predicates (reference)

> **Diátaxis quadrant:** Reference. This is the canonical specification of the
> capability gate `check.predicate` evaluation path. For a step-by-step
> authoring guide, see [How-to: add a command-exit-zero gate](../how-to/command-exit-zero-gate.md).

A capability gate's `check` block carries exactly one of three shapes
(`query`, `predicate`, `agentVerdict`), enforced by the registry validator
(`capability-validator.cjs:validateGate`). This page documents the
**`predicate`** shape and the kinds the built-in evaluator recognises.

## Declaration

```json
"gates": [
  {
    "point": "<loop-point>",
    "check": {
      "predicate": {
        "kind": "<kind>",
        "<kind-specific fields>"
      }
    },
    "when": "<config-key>",
    "blocking": true,
    "onError": "halt"
  }
]
```

The gate envelope (`point`, `when`, `blocking`, `onError`) follows the standard
contract documented in ADR-0894 (capability declaration format) and the
`Loop Host Contract` glossary entry in `CONTEXT.md`. This page covers only
`check.predicate`.

## Evaluation path

1. The loop-resolver (`gsd-tools loop render-hooks <point>`) renders the active
   gate hook (including its `check.predicate` declaration) to the workflow.
2. The workflow gate-dispatch reads the hook in-context and, when the `check`
   shape is `predicate`, runs:
   ```bash
   gsd_run check predicate --predicate '<predicate JSON>' [--phase-dir …] [--phase-number …] [--phase-req-ids …] --raw
   ```
3. `gate-predicate.cts:evaluateCheckPredicate`, dispatched by the check command
   router, parses the predicate, builds the production subprocess binding, and calls
   `gate-predicate-evaluator.cjs:evaluatePredicate`, which dispatches by
   `predicate.kind`.
4. The evaluator returns the standard gate envelope:
   ```json
   { "block": <bool>, "message": "<string>", "details": { … } }
   ```
5. The workflow applies the **two-step gate contract** unchanged:
   - **Step 1** — if the check command itself failed (non-zero exit, e.g. a
     malformed predicate / unknown kind), route per `onError` (`halt` or `skip`).
   - **Step 2** — if the command succeeded, a `blocking: true` gate halts on
     `block: true`; an advisory gate shows `message` and continues.

## Built-in kinds

### `command-exit-zero`

Runs a declared command in a bounded `sh -c` subprocess; **exit 0 → pass,
non-zero → block, timeout → block.** See ADR-2008 for the full sandbox
contract.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `kind` | string | yes | — | Must be `"command-exit-zero"` |
| `command` | string | yes | — | The shell command. Non-empty, ≤ 4096 chars |
| `timeout` | number | no | `30` | Positive finite number, seconds |

**Phase context environment (ADR-2008 amendment, 2026-10-14).** GSD passes
phase context as environment data and never substitutes text into `command`.
Use quoted shell expansion to pass each value as one literal argument:

| Environment variable | Source | Workflow flag |
|---|---|---|
| `GSD_GATE_PHASE_NUMBER` | the active phase number | `--phase-number` |
| `GSD_GATE_PHASE_DIR` | the resolved absolute phase directory | `--phase-dir` |
| `GSD_GATE_PHASE_REQ_IDS` | the phase's requirement ids | `--phase-req-ids` |

For example, `test -d "$GSD_GATE_PHASE_DIR"` receives a directory containing
quotes, backticks or `$(...)` as data. These three variables override inherited
values; missing context is set to the empty string, so ambient variables cannot
supply stale phase context. Other environment variables remain inherited and
available to the shell as usual.

**Breaking migration.** The old GSD placeholders `${PHASE_NUMBER}`,
`${PHASE_DIR}` and `${PHASE_REQ_IDS}` are rejected before execution, including
inside quotes, with a diagnostic naming the corresponding
`"$GSD_GATE_PHASE_NUMBER"`, `"$GSD_GATE_PHASE_DIR"` or
`"$GSD_GATE_PHASE_REQ_IDS"` replacement. Update capability manifests; neither
single-quoting an old placeholder nor escaping phase data restores that contract.
The replacement is ordinary shell expansion of environment data, not a GSD
placeholder syntax. GSD does not provide a command-text substitution language.

**`--phase-dir` is confined to the project.** The value is validated to resolve
inside the project root before either predicate kind is evaluated; one that
escapes is rejected as a usage error. `artifact-frontmatter-equals` resolves its
artifact under that directory, and `command-exit-zero` receives it in
`GSD_GATE_PHASE_DIR`, so an unconfined value could let a **blocking** gate return
`block: false` on evidence from a directory the caller chose (#4354). An absolute
path inside the project is accepted. `GSD_GATE_PHASE_DIR` always contains the
**resolved absolute path**, even when `--phase-dir` was relative.

**Sandbox.** cwd = project root; env = inherited with the three phase context
variables above overridden; the direct shell is killed (SIGTERM) on timeout.
The capability-authored command remains trusted shell code running as the user,
on the user's machine. Environment transport protects phase data, without adding
a sandbox boundary or restricting capability-authored shell operations. See
ADR-2008 "Trust model".

**Result mapping.**

| Command outcome | `block` | `message` |
|---|---|---|
| exit 0 | `false` | `command exited 0` |
| exit N (non-zero) | `true` | `command exited N: <stderr/stdout tail, ≤2000 chars>` |
| timeout (SIGTERM) | `true` | `command timed out after <s>s: <tail>` |
| `sh` missing (ENOENT, exit 127) | `true` | `command exited 127: sh: not found` |

**Validation errors (throw → check-command failure → Step-1 / `onError`).**

- Missing, non-string, empty, or whitespace-only `command`.
- `command` longer than 4096 chars.
- Any retired `${PHASE_NUMBER}`, `${PHASE_DIR}` or `${PHASE_REQ_IDS}` spelling in `command`.
- `timeout` present but not a positive finite number.
- Unknown `kind`.

### `artifact-frontmatter-equals`

Reads a Markdown file with YAML frontmatter from the current phase directory (or falls back to the project root for project-level artifacts) and compares a field's value to the declared expectation. The value is matched using loosely typed string comparison or exact matching, where numeric expectations will safely match stringified numeric frontmatter values.

`artifact` matches `<name>`, `.planning/<name>`, and every `*-<name>` in the directory. Exactly one match is read (a symlink that resolves to the same file counts once); more than one fails closed (`block: true`) naming every candidate, never the first the OS listed (#5313).

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `kind` | string | yes | — | Must be `"artifact-frontmatter-equals"` |
| `artifact` | string | yes | — | Suffix or exact filename (e.g. `WINDOWS.md`) |
| `field` | string | yes | — | Frontmatter key to read |
| `equals` | any | yes | — | Expected value (compared with string coercion) |

**Result mapping.**

| Command outcome | `block` | `message` |
|---|---|---|
| Value matches `equals` | `false` | `Frontmatter field "<field>" matches expected value (<expected>)` |
| Value mismatch | `true` | `Frontmatter field "<field>" in <artifact> is <actual>, expected <expected>` |
| Artifact file not found | `true` | `Artifact matching <artifact> not found in <targetDir>` |
| More than one file matches | `true` | `Multiple artifacts match <artifact> in <targetDir>: <names sorted by path>; remove or rename all but one` (`details.ambiguous`, `details.candidates`) |

**Validation errors (throw → check-command failure → Step-1 / `onError`).**

- Missing or empty `artifact` string.
- Missing or empty `field` string.
- Missing `equals` value.
- File read or YAML parsing failure (I/O errors).
- Phase directory exists but cannot be listed (also when the artifact sits directly in it).

## Extensibility

The evaluator dispatches through a `KIND_TABLE`. Adding a new built-in kind is
a one-line registration in `gate-predicate-evaluator.cts` — no workflow changes
required, since the workflow dispatches any `check.predicate` to the same
`gsd_run check predicate` subcommand.

## Related

- [ADR-2008](../adr/2008-command-exit-zero-gate.md) — full decision record.
- [How-to: add a command-exit-zero gate](../how-to/command-exit-zero-gate.md).
- ADR-0894 — capability declaration format.
- `src/gate-predicate-evaluator.cts`, `src/check-command-router.cts`.
