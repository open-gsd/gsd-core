# ADR-2008: Generic gate-predicate evaluator

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-04 |
| **Issue** | [#2008 — No generic evaluator for third-party capability gates](https://github.com/open-gsd/gsd-core/issues/2008) |
| **Supersedes** | — |
| **Amends** | ADR-0894 (capability declaration format — `check.predicate` evaluation path) |

## Context

Capability gates are declared in `capability.json` under `gates[].check`. The
registry validator (`capability-validator.cjs:validateGate`) recognises three
mutually-exclusive `check` shapes — `query`, `predicate`, and `agentVerdict` —
and the loop-resolver (`loop-resolver.cts:renderLoopHooks`) renders all active
gates to the workflow gate-dispatch sites.

Prior to this ADR, only `check.query` was **enforced**: every workflow
gate-dispatch site ran `gsd_run check ${hook.check.query}`, which routes through
the fixed if-chain in `check-command-router.cts:routeCheckCommand`. A
`check.predicate` (e.g. the `security` capability's
`artifact-frontmatter-equals` declaration) was **declaration-only** — rendered
for display, never evaluated. The security capability's `threats_open == 0`
enforcement worked only because `ship.md` hard-codes a `capId == "security"`
prose branch that reads `SECURITY.md` frontmatter directly. There was no
extension path for a third-party capability's gate to actually fire.

Issue #2008 asked for a generic, data-driven gate-evaluation path. Two candidate
directions were proposed:

1. A generic `check.predicate` evaluator covering `artifact-frontmatter-equals`
   and future kinds.
2. A documented, sandboxed **`command-exit-zero`** gate kind — "run `<cmd>`,
   block on non-zero exit" — matching the git-hook / CI-runner enforcement
   shape.

The maintainer chose **Option 2** (issue comment, 2026-07-04).

## Decision

Add a **generic gate-predicate evaluation path** with two built-in kinds,
`command-exit-zero` and `artifact-frontmatter-equals`, scoped as follows.

### Declaration shape

A capability declares a `command-exit-zero` gate under the existing
`check.predicate` block (already a first-class, validator-accepted shape):

```json
"gates": [
  {
    "point": "ship:pre",
    "check": {
      "predicate": {
        "kind": "command-exit-zero",
        "command": "node scripts/check.sh \"${PHASE_DIR}\"",
        "timeout": 30
      }
    },
    "when": "my_cap.enabled",
    "blocking": true,
    "onError": "halt"
  }
]
```

`predicate.command` is required (non-empty string, ≤ 4096 chars).
`predicate.timeout` is optional (positive finite number, seconds; default 30).

### Sandbox contract (the security core of this ADR)

| Axis | Value | Rationale |
|---|---|---|
| Interpreter | `sh -c` (via `shell-command-projection.execTool`) | Cross-platform with the runtime's existing bash dependency; one string, no argv array to author |
| cwd | Project root (the runtime `cwd`) | Matches the user's working context; the same root existing `check.query` gates operate from |
| Environment | Inherit process env | The command runs as the user, on the user's machine, in the project they are working on — no sandbox boundary is crossed vs. the user's own shell. Override via the command itself (`env VAR=x ...`) |
| Timeout | Default 30s; overridable per-gate | Bounded execution is non-negotiable; an unbounded gate could hang the loop forever |
| Interpolation | `${PHASE_NUMBER}`, `${PHASE_DIR}`, `${PHASE_REQ_IDS}` substituted from gate context; undefined → `''`; all other `${X}` left untouched for `sh` to interpret | Parity with the context existing `check.query` gates already receive |
| Result mapping | exit 0 → `block:false`; non-zero → `block:true`; timeout (SIGTERM) → `block:true` (`timed_out`); `sh` missing (ENOENT, exit 127) → `block:true` | Fail-closed: every non-zero outcome blocks. A blocking gate with `block:true` halts per the existing two-step gate contract |
| Output cap | stderr/stdout tail embedded in `message` trimmed to 2000 chars | Keeps the `GATE_RESULT` payload context-bounded |

### Evaluation path

- A new pure leaf module `src/gate-predicate-evaluator.cts` owns
  `evaluatePredicate(predicate, context, deps)`. It is fully deps-injected (the
  subprocess seam is `runBoundedShell`) — no fs, no child_process, no config —
  so it is trivially unit-testable without spawning. A `KIND_TABLE` dispatches
  by `predicate.kind`; adding a future kind is a one-line registration.
- `check-command-router.cts` gains a `predicate` subcommand
  (`gsd_run check predicate --predicate '<json>' [--phase-dir …] [--phase-number …]
  [--phase-req-ids …] --raw`). It parses flags, builds the production deps
  (wrapping `execTool`), calls `evaluatePredicate`, and emits the standard
  `{ block, message, details? }` envelope via `output()`.
- The three generic workflow gate-dispatch sites — `execute:wave:post`,
  `execute:post`, `plan:post` — now branch on the gate's `check` shape:
  `check.query` → existing `gsd_run check <query>` path; `check.predicate` →
  `gsd_run check predicate`. The two-step Step-1 (command-failure → `onError`)
  / Step-2 (`block` → halt) contract is **unchanged** — the predicate path
  emits the same envelope and the same check-command-failure semantics.

### Fail-closed mapping for malformed predicates

`evaluatePredicate` **throws** for a malformed predicate (missing/non-string
command, non-positive timeout, oversized command, unknown kind). The CLI
wrapper maps a throw to `error()` (non-zero exit), which the workflow treats as
a **Step-1 command failure** — routed per the gate's `onError` (`halt` or
`skip`). This deliberately does **not** conflate an evaluator bug with a
legitimate gate-block decision: a recognised predicate returns
`{ block, … }`; an unrecognised one fails the check command.

## Trust model

Capabilities are opt-in installs (like npm packages): installing one already
trusts it to ship skills, agents, and hooks that run arbitrary code.
`command-exit-zero` is therefore **not a new trust boundary** — it is another
code-execution path for already-trusted capabilities. Security does not rely on
secrecy (Kerckhoffs): the command is declared in plain JSON, and safety comes
from bounded timeout + fail-closed mapping + the opt-in install, not from
hiding the mechanism.

## Consequences

- **Positive:** Third-party capability gates now actually fire. The path is
  generic; future predicate kinds (e.g. a revival of `artifact-frontmatter-equals`
  to retire the hard-coded `ship.md` security branch) register in `KIND_TABLE`
  without further workflow changes.
- **Positive:** The evaluator is a pure leaf with injected I/O, matching the
  ADR-857 module decomposition and the repo's test conventions.
- **Negative / documented limitation:** A command that backgrounds a child
  (`sleep 100 &`) can outlive the timeout kill of its direct `sh` parent —
  `execTool` kills the direct child on SIGTERM, not the whole process group.
  This is the same property the existing `check.query` gates have (they too can
  spawn long-running subprocesses). Full process-group kill is a future
  hardening, out of scope here; the threat is a malicious capability, which is
  already trusted.
- **Negative:** `sh` must be present. On Windows without a POSIX shell
  (git-bash / WSL), `command-exit-zero` gates fail-closed with exit 127. This
  matches the runtime's existing bash dependency for workflows.

## Out of scope

- Retiring the hard-coded `security` branch in `ship.md`.
- `check.agentVerdict` evaluation (advisory, `blocking:false`-forced, separate
  concern).
- Process-group kill on timeout.

## References

- Issue: [#2008](https://github.com/open-gsd/gsd-core/issues/2008)
- Parent bundle: #2004
- ADR-0894 (capability declaration format)
- ADR-0857 (capability system / module decomposition)
- `src/gate-predicate-evaluator.cts`, `src/check-command-router.cts`
- Diátaxis docs: `docs/reference/gate-predicates.md`, `docs/how-to/command-exit-zero-gate.md`

## Amendment — 2026-10-14: Phase context is environment data

Issue [#5318](https://github.com/open-gsd/gsd-core/issues/5318) intentionally
revisits the original **Interpolation** and **Environment** rows above. Textual
substitution turned filesystem and CLI data into shell code: a phase directory
containing `$(...)` or backticks executed substitutions even inside double
quotes, while an apostrophe broke a single-quoted placeholder. The original
Decision and examples remain the historical record; this amendment governs the
current command contract.

GSD performs **no textual substitution** in `command-exit-zero` command text.
The evaluator passes three environment entries to `runBoundedShell`; the
production binding forwards them to `shell-command-projection.execTool`, which
merges them over the inherited process environment:

| Environment variable | Gate context | Absent value |
|---|---|---|
| `GSD_GATE_PHASE_NUMBER` | `phaseNumber` / `--phase-number` | `''` |
| `GSD_GATE_PHASE_DIR` | `phaseDir` / `--phase-dir`, resolved absolute path | `''` |
| `GSD_GATE_PHASE_REQ_IDS` | `phaseReqIds` / `--phase-req-ids` | `''` |

The `GSD_GATE_` namespace distinguishes supplied gate context from ordinary
user shell variables. Every invocation overrides all three entries, including
absent values, so inherited values cannot override context or supply a stale
phase. Unrelated environment entries remain inherited. The names are
**environment-variable names, not GSD command placeholders**; only the shell
performs its ordinary expansion. Capability authors pass them as quoted data:

```json
{
  "kind": "command-exit-zero",
  "command": "node checks/pre-ship.js \"$GSD_GATE_PHASE_DIR\" \"$GSD_GATE_PHASE_NUMBER\" \"$GSD_GATE_PHASE_REQ_IDS\"",
  "timeout": 30
}
```

This is a **breaking manifest change**. The old `${PHASE_NUMBER}`,
`${PHASE_DIR}` and `${PHASE_REQ_IDS}` spellings are rejected as malformed
command predicates before any subprocess runs. Each diagnostic names the
matching `"$GSD_GATE_PHASE_NUMBER"`, `"$GSD_GATE_PHASE_DIR"` or
`"$GSD_GATE_PHASE_REQ_IDS"` replacement. Rejection also applies inside quotes;
there is no escaping or quoting compatibility mode and no alternative GSD
placeholder language whose spelling could collide with a shell's syntax.
A malformed declaration remains a Step-1 check-command failure routed by
`onError`, rather than a successful negative gate verdict.

The capability-authored command remains trusted `sh -c` code under the original
opt-in install trust model. This amendment protects **phase context data**; it
does not sandbox capabilities or restrict commands they deliberately author.
Project-root cwd, command-length validation, bounded timeouts, output limits,
result mapping, and the #4354 project confinement of `--phase-dir` are unchanged.
`timedOut` is taken from the Shell Command Projection Module's `ETIMEDOUT`
classification; a self-delivered SIGTERM blocks as a non-zero command result
without claiming a timeout. `artifact-frontmatter-equals` is unchanged.

The current authoring contract is documented in
`docs/reference/gate-predicates.md` and
`docs/how-to/command-exit-zero-gate.md`. The evaluator no longer exports its
retired `interpolate` helper or `INTERPOLATION_VAR_NAMES` list.
