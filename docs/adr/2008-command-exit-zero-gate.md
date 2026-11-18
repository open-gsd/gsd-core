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
        "command": "node scripts/check.sh \"${GSD_PHASE_DIR}\"",
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
| Interpolation | `GSD_PHASE_NUMBER`, `GSD_PHASE_DIR` and `GSD_PHASE_REQ_IDS` are set in the gate shell's environment from the gate context (undefined → `''`); no value is substituted into the command text, and every other `${X}` is left for `sh` to interpret. History: the first revision substituted `${PHASE_NUMBER}`, `${PHASE_DIR}` and `${PHASE_REQ_IDS}`; see "Amendment (2026-11-18)". | Parity with the context existing `check.query` gates already receive |
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

## Amendment (2026-11-06): the evaluator keeps the output tail inside the cap (#5593)

Recorded as a dated section because ADRs here are append-only. The Output cap row above reads as superseded on this one point.

The 2000-character cap on the whole `message`, prefix included, is unchanged. What changed is the end that survives: the evaluator now keeps the tail of stderr or stdout. On a timeout with empty or whitespace-only stderr it keeps the head of the command, so the program name survives. Whitespace-only stderr counts as empty, so a non-zero exit then shows stdout.

## Amendment (2026-11-18): placeholders are environment values (#5482)

The Interpolation row above describes the first revision, which pasted the values into the command text. A directory name that held shell syntax then ran as a command. The gate shell now receives `GSD_PHASE_NUMBER`, `GSD_PHASE_DIR` and `GSD_PHASE_REQ_IDS` as environment values, in addition to the inherited process environment (the Environment row). The `GSD_` prefix keeps them apart from ordinary user shell variables. This follows the maintainer ruling on #5318.

GSD pastes no value into the command text; the command reaches `sh` unchanged, so a gate double-quotes the variable (`"${GSD_PHASE_DIR}"`).

The old names `PHASE_NUMBER`, `PHASE_DIR` and `PHASE_REQ_IDS` are no longer set. The evaluator throws for a command that uses one (`${PHASE_DIR}`), in single, double or no quotes, and the gate takes its `onError` path (`unevaluable`). The message names the replacement. Migration: `test -n '${PHASE_NUMBER}'` becomes `test -n "${GSD_PHASE_NUMBER}"`. The beads ship gate (gsd-beads-i7e7) migrates to `$GSD_PHASE_NUMBER`.

The evaluator throws (`unevaluable`) unless every `GSD_PHASE_*` variable is provably in plain double quotes, outside any text that a consumer parses again. It follows only `'`, `"`, a backslash and `${...}` depth, so it refuses what it cannot read: a variable that is unquoted, single-quoted (except as the next sentence says), escaped by a backslash or written `$$GSD_PHASE_DIR`, and a variable after `$(`, a backtick, `<<`, `$'`, a quote inside `${...}`, or a `#` that starts a word. A single-quoted variable is read, not refused, when its text is the script word of `sh -c` or the argument of `eval` or `trap`: the inner shell inherits the environment, so the value never becomes script text, and the walk checks that text on its own (a bare `$GSD_PHASE_DIR` inside it splits the value and is refused). It also refuses a double-quoted variable in the text that `eval`, `trap` or `sh -c` parses again (`sh` stands for `bash`, `dash`, `ksh`, `zsh` and `ash` too, and for the shell that `xargs` and `find -exec` start): the outer shell has already pasted the value into that text, so a directory name such as `x$(touch PWNED)` would run as a command. A command that runs `xargs` without `-0` or `-d` is refused for any variable, because `xargs` splits and unquotes what it reads. This follows the maintainer reviews of 2026-11-08 ("Throw unless every non-inert placeholder is provably in the double-quote state") and 2026-11-18 (refuse "a gate that passes a placeholder inside the argument of a re-parsing consumer"), and it refuses some commands that are correct. The fix is to assign the variable first, in plain double quotes, and use the shell variable where the refused construct needs it. Every later use of the copy is double-quoted too, because `d="${GSD_PHASE_DIR}"; ... $d` splits the value again:

- `d="${GSD_PHASE_DIR}"; test -z "$(ls -A "$d")"` replaces `test -z "$(ls -A "${GSD_PHASE_DIR}")"`.
- `ids="${GSD_PHASE_REQ_IDS}"; for id in $ids; do ...; done` replaces `for id in $GSD_PHASE_REQ_IDS`; the word split is now the author's own.
- `sh -c 'test -d "$GSD_PHASE_DIR"'` replaces `sh -c 'test -d $GSD_PHASE_DIR'`; the child shell reads the variable from its environment and the double quotes keep the value one word. `sh -c 'test -d "$1"' sh "${GSD_PHASE_DIR}"` replaces `sh -c "test -d ${GSD_PHASE_DIR}"`; the value is a later argument, which the child shell reads as data.
- `d="${GSD_PHASE_DIR}"; eval 'test -d "$d"'` replaces `eval "test -d \"${GSD_PHASE_DIR}\""`; the text that `eval` parses holds `$d`, never the value. `trap` takes the same spelling: `d="${GSD_PHASE_DIR}"; trap 'rm "$d"' EXIT`.
- `printf '%s\0' "${GSD_PHASE_DIR}" | xargs -0 ls` replaces `echo "${GSD_PHASE_DIR}" | xargs ls`.
- `test -d "${GSD_PHASE_DIR}" # note` replaces a comment line before the variable.

A fifth dispatch site joins the three generic workflow sites listed under Evaluation path and the generic `ship:pre` site (#3559): the engine backstop in `milestone complete` (`milestone.cts:findBlockingShipGates`). It re-runs blocking `ship:pre` predicate gates per milestone phase.
