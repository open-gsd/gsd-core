# Verify Command Validation (#4586)

> Reference file for the gsd-planner agent (authoring) and the gsd-plan-checker agent (Check 8g).
> Loaded on-demand via `@` reference from the `<failing_direction_contract>` block of the planner
> spawn prompt in `gsd-core/workflows/plan-phase.md`; the checker reads the last section.

**Where a validate-only mode exists for an `<automated>` command's language or tool, run it at plan
time and record the result.** A `<fails_when>` statement names what failure would look like; it cannot
reveal that the command does not parse. A check that cannot compile has never tested anything, yet it
reads as rigor in a green battery.

**Why.** #4586: a seven-plan T-SQL phase satisfied the `<fails_when>` contract in full and still shipped
commands that could not run (`Msg 8155`: an unaliased derived-table column; `CONCAT()` with one argument).
Each executor then had to decide whether the check or the deliverable was wrong, and the wrong answer,
"adjust the deliverable until the check passes", silently corrupts the thing being verified. A parse-only
pass at plan time removes that judgment call.

**Validate-only means all four:** it does not execute the body, does not write to the tree, does not need
the command's targets to exist yet, and needs no network or install. A mode that fails any of the four is
not validate-only, however it is named. Check #2401 grounding (does the target exist) is a separate claim.

## Sanctioned forms

The closed set. Use a form only for the body language it names.

| Id | Body language | Sanctioned form | Needs |
|---|---|---|---|
| `bash-n` | POSIX shell | `bash -n` over the body | `bash` |
| `node-check` | JavaScript | `node --check` over the body saved as a `.cjs` file | `node` |
| `python-ast` | Python | `python3 -I -c 'import ast,sys; ast.parse(sys.stdin.read())'` with the body on stdin | `python3` |
| `tsql-parseonly` | T-SQL | `SET PARSEONLY ON;` sent in an open session, then the body, then `SET PARSEONLY OFF;` | a reachable SQL Server session |
| `cargo-metadata` | Rust target shape | `cargo metadata --no-deps --format-version 1` confirms the package and targets a command names exist | `cargo` and a `Cargo.toml` |

`cargo-metadata` validates a command's target shape (the #3172 `--lib` against a binary-only package case),
not a command line. `tsql-parseonly` examines syntax and resolves no object names, so it works before the
objects exist, but it needs a live session: with none, the body is unvalidatable.

## Never at plan time

Each of these looks like a validate mode and is not. Do not run them while authoring a plan.

| Form | Why never at plan time |
|---|---|
| `python -m py_compile` | writes a `__pycache__/*.pyc` into the tree |
| `cargo check` (also `cargo build`, `cargo test`) | compiles the crate: runs its build scripts and procedural macros, which are project code, and writes `target/` |
| `npm run <script> --dry-run` | `npm run` ignores `--dry-run` and executes the script |
| `terraform validate` | needs an initialized directory with plugins and modules installed, and `init` fetches over the network |

## Running a form safely

- **The body is data.** Feed it as a file in the OS temp directory or on stdin. Never splice it into the argv
  of the validator or into a shell string: a body containing `$(…)`, backticks, or quotes must stay inert.
- **Validate each layer.** `sqlcmd -Q "SELECT …"` is a shell layer wrapping a SQL layer. `bash -n` passing
  validates the shell layer only. Run the inner layer's form on the inner text, or mark it unvalidatable.
- **An empty or whitespace-only body is not a validation result.** An empty file parses everywhere, so exit 0
  alone proves nothing. An empty body is also a `<automated>` problem the existing probe already reports.
- **A failing validator blocks the plan.** Correct the command and run the form again. Never weaken or delete
  the `<fails_when>`, and never edit the deliverable so the command parses.
- **Record only an observed result.** Write `[VALIDATED: …]` only after the form ran and exited 0 in this
  session. The checker can re-run the read-only forms and a mismatch blocks.

## Notation

Record the result inside the task's `<verify>`, after the command's `<fails_when>`, one line per command.
The line binds to the nearest preceding `<automated>`, exactly as `<fails_when>` does: N commands need N lines.
This is plain text, not a new element, so the plan schema and the #2401 and #3172 probes are unchanged.

```
[VALIDATED: <validate-only command> exit 0]
[VALIDATED: prior_verify_commands]
[UNVALIDATABLE: <reason>]
```

- `[VALIDATED: prior_verify_commands]` is for a command inherited verbatim from `prior_verify_commands`: it
  already ran in a prior phase and its output was observed.
- `[UNVALIDATABLE: <reason>]` means no sanctioned form applies or its needs are absent at plan time (for
  example `no SQL Server session at plan time`, `target created by task 2`, `no sanctioned form for this
  language`). The planner then keeps the existing behavior: state the failing direction and move on.
- The reason is non-empty and specific. These are the same placeholder atoms `<fails_when>` rejects as whole values:

**Rejected as a reason:** `TBD`, `TODO`, `N/A`, `NA`, `none`, `unknown`, `TBA`, `?`, `-`

- An empty or whitespace-only body takes no notation: it is not a command.
- The `MISSING — Wave 0 must create …` sentinel is not runnable and takes no notation.

## Checker (Check 8g)

For each runnable `<automated>` command in the plan, find its notation line.

| Finding | Severity |
|---|---|
| no notation, command is not a `MISSING — Wave 0` sentinel | **WARNING**: quote the command; it was neither validated nor marked unvalidatable. Plans written before this check have no notation, so absence is never a blocker |
| `[VALIDATED: …]` and a read-only re-run of the form (`bash -n`, the `python-ast` program, `node --check`) fails on the command | **BLOCKER**: quote the command and the validator's first error line |
| `[UNVALIDATABLE: <reason>]` with a placeholder or empty reason | **BLOCKER**: it is not a considered answer |
| `[UNVALIDATABLE: …]` naming a form from the sanctioned table that needs nothing the plan lacks | **WARNING**: the form was available |
| `[VALIDATED: prior_verify_commands]` and the command is not in `prior_verify_commands` | **BLOCKER**: the claim is unsupported |
| sentinel command, or `[VALIDATED …]` / `[UNVALIDATABLE …]` text outside `<verify>` | silent |

Rules:

- **Re-run only the read-only forms** in the sanctioned table, never a form from the Never table, and never
  a body that builds, installs, or writes. If a form's needs are absent on the checking host, do not mark it
  failed: report it as not re-run.
- **Report, never prescribe.** State which command lacks a record or fails its form. Do not write the
  notation for the planner: a prescribed record is copied verbatim and carries no information.
- A command that hangs or never returns is not parse-detectable. This check does not claim to catch it.
