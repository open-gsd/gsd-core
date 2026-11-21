# Validate an automated command

`gsd-plan-checker` check 8g warns when an `<automated>` acceptance command has no validation record.
This page is what to do about it: how to validate a command without running it, how to record the
result, and when to mark a command unvalidatable instead.

## The rule

Where a validate-only mode exists for a command's language or tool, run it and record the result inside
the task's `<verify>`, after the command's `<fails_when>`:

```xml
<verify>
  <automated>bash scripts/check-release.sh</automated>
  <fails_when>non-zero exit</fails_when>
  [VALIDATED: bash -n exit 0]
</verify>
```

The record binds to the nearest preceding `<automated>`, exactly as `<fails_when>` does. Two commands need
two records.

## Pick the form

| Body language | Run | Needs |
|---|---|---|
| POSIX shell | `bash -n` over the body | `bash` |
| JavaScript | `node --check` over the body saved as a `.cjs` file | `node` |
| Python | `python3 -I -c 'import ast,sys; ast.parse(sys.stdin.read())'` with the body on stdin | `python3` |
| T-SQL | `SET PARSEONLY ON;` in an open session, then the body | a reachable SQL Server session |
| Rust target shape | `cargo metadata --no-deps --format-version 1` | `cargo` and a `Cargo.toml` |

Feed the body as a file or on stdin. Never splice it into the validator's argv or into a shell string.
A command that wraps another language (`sqlcmd -Q "SELECT …"`) has two layers: `bash -n` validates the shell
layer only, so validate the inner text with its own form or mark it unvalidatable.

## Do not use these

`python -m py_compile` writes a `.pyc`. `cargo check` runs the crate's build scripts and procedural macros.
`npm run <script> --dry-run` executes the script, because `npm run` ignores `--dry-run`. `terraform validate`
needs an initialized directory. None of them is validate-only.

## When the validator fails

The plan is blocked. Correct the command and run the form again. Do not weaken or delete the `<fails_when>`,
and do not change the deliverable so the command parses.

## When no form applies

Write `[UNVALIDATABLE: <reason>]` with a specific reason, for example `no SQL Server session at plan time` or
`target created by task 2`. The command then behaves exactly as before: the failing direction is the only
record. A placeholder reason (`TBD`, `N/A`, `none`, `?`, `-`) is a BLOCKER, because it is not a considered answer.

A command inherited verbatim from `prior_verify_commands` takes `[VALIDATED: prior_verify_commands]`: it
already ran in a prior phase.

## Read the checker's verdicts

| Verdict | Meaning | Do |
|---|---|---|
| WARNING, no record | the command was neither validated nor marked unvalidatable | run a form and record it, or write `[UNVALIDATABLE: …]` |
| BLOCKER, re-run failed | the checker re-ran a read-only form and it fails on the command | fix the command |
| BLOCKER, placeholder reason | `[UNVALIDATABLE: TBD]` | give the real reason |
| silent | a record that holds, or a `MISSING — Wave 0` sentinel | nothing |

A plan written before this check has no records and draws one WARNING per command. It is never a BLOCKER.

## What this does not catch

A command that never returns has no exit code, so no validator reports it. This tier does not claim to
catch it.
