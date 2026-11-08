# ADR-4310: Opt-in replay of recorded criterion baselines

- **Status:** Accepted
- **Date:** 2026-11-08
- **Issue:** [#4310](https://github.com/open-gsd/gsd-core/issues/4310) (approved-feature, Go-with-conditions on 2026-09-05, reaffirmed 2026-11-08). It is half 3 of [#4024](https://github.com/open-gsd/gsd-core/issues/4024).
- **Amends:** [ADR-4309](4309-criterion-baseline-notation.md): it decides the `--replay` question ADR-4309 left open, and adds a parsed-notation list to the Criterion Baseline Module's scan result.

## Context

ADR-4309 made the baseline a declared value: `[HEAD=2 EXPECT>=3]` says the command printed 2 before the work. Nothing checks that claim. Its known limits say so: "`HEAD` is a declared value; nothing checks it was measured. That is #4310." A planner who guessed a baseline gets the same verdict as one who measured it. The guess surfaces only when the phase executor runs the command, after the plan was accepted.

The only way to check a recorded baseline is to run the command. `verify plan-structure` has never executed anything. This ADR decides how it may.

## Decision

### 1. Opt-in only

`verify plan-structure <file> --replay` executes. Without the flag, the verb stays pure text, runs no subprocess, and its payload is byte-identical to before. No workflow and no agent passes the flag. Wiring replay into a gate needs its own later decision.

### 2. Advisory only

A replay result never changes `valid` or the exit code.

- **Mismatch.** The printed value differs from the recorded `HEAD`. It is reported in `replay.results` with `outcome: "mismatch"`, and a warning is added to `warnings`.
- **Status.** The command could not be replayed. It is reported in `replay.statuses` from a closed set: `no_command`, `ambiguous_command`, `malformed_command`, `disallowed`, `cannot_run`, `timeout`, `output_cap`, `budget_exhausted`, `truncated`, `replay_error`. "Could not look" is not evidence about the plan, so it is not a finding. This is the same fail-open rule ADR-4309 applies to parse failures.

### 3. The quarantine

A criterion's command is free text written by the plan's author. Replay treats it as hostile:

- **No shell, ever.** The command is split into argv by a recognizer, not a shell interpreter. The recognizer understands single quotes, double quotes and backslash escapes, and nothing else. Any construct a shell would expand or interpret makes the command `disallowed`, and it is never run. That covers unquoted `| & ; < > ( ) $ ` * ? [ { } ~`, a token starting with `#`, `$` or a backtick inside double quotes, and CR, LF or NUL.
- **Basename allowlist.** The program must be the bare name `grep` or `git`. A path (`./grep`, `/usr/bin/grep`) is disallowed. `git` must be followed directly by one of `grep`, `ls-files`, `rev-parse` or `rev-list`, with no global option before it. Options are an **exact-match allowlist** per program and subcommand, not a denylist. git and GNU grep both accept any unambiguous prefix of a long option, so a denylist of `--open-files-in-pager` is bypassed by `--open-files=sh`. An abbreviation is never on the list. Short options are boolean flags only, so a cluster such as `-ncf<file>` cannot smuggle in a value-taking option. `-e` (pattern next) is the one exception, plus `-n` for `rev-list`.
- **Arguments stay in the project.** An absolute path, a drive or UNC path, or a `..` segment is disallowed. This applies to any argument and to the value of `--opt=value`. An argument that names an existing file must also resolve, through symlinks, inside the project root. Symlink-following recursion (`-R`) is not on the allowlist.
- **No cwd search on Windows.** A bare name that does not resolve on `PATH` is `cannot_run`. It is never handed to `CreateProcess`, which would search the project directory first.
- **Pinned cwd.** Every command runs with the project root as cwd.
- **Bounds.** A command may be at most 1,000 characters and 64 tokens. Each command gets 10 s and a 64 KiB output cap. A run replays at most 50 commands within a 60 s total budget. git runs with the read-only environment `execGit` uses, plus `GIT_PAGER=cat`.
- **One spawn seam.** The process starts through `execArgvQuarantined` in the Shell Command Projection Module, with `shell: false`. On Windows that seam would otherwise mediate a `.cmd`/`.bat` through `cmd.exe`, so the primitive refuses mediation instead (`cannot_run`).
- **No output echo.** The payload carries only the value derived from the result, never raw stdout or stderr.

**Measured against the step/gate discipline** (`references/loop-hook-dispatch.md`, `step` → `ref.command` and `gate` → `check.predicate`). Those rules make the agent validate a manifest-supplied value in context, before any shell use, and pass it as a single argv element that is never re-quoted. Their named hostile set is a quote, `;`, a backtick, `$(` and a newline. Replay keeps the same invariants, enforced in code rather than in agent prose, and goes further: no shell is ever started, so nothing can be re-quoted into one. A parity test feeds the step/gate hostile set to the replay recognizer and asserts that none of it reaches execution. Replay deliberately does not reuse the `command-exit-zero` gate predicate, because that predicate runs `sh -c`.

### 4. Locating the command

The notation does not carry its command. It is read from the notation's own line, in the two forms the planner reference documents:

- **Acceptance line:** exactly one backtick span before the notation (`` - `grep -c "x" f` -ge 1 [HEAD=0 EXPECT>=1] ``). Two or more spans give `ambiguous_command`.
- **Automated line:** the text before the trailing shell comment (`grep -c "x" f   # [HEAD=0 EXPECT>=1]`), with any leading `<verify>`, `<automated>` or `<acceptance_criteria>` tag removed.

Anything else gives `no_command`.

### 5. Deriving the observed value

| Result | Observed |
|---|---|
| exit 0 or 1, and stdout is one integer | that integer (`grep -c` with no match exits 1 and prints `0`) |
| exit 0, anything else | `present` |
| exit 1, anything else | `absent` |
| exit 2–255 | `error:<code>` |
| not found, killed, refused, timed out, over the cap | a status, not a value |

The observed value is compared with the recorded `HEAD` using ADR-4309's equality: kinds never compare equal across each other. `EXPECT` is not checked, because it describes the tree after the work.

When the notation is pinned (`@<sha>`) and the current `HEAD` commit does not start with that sha, the result carries `rev_drift: true`. A mismatch on a drifted pin may be honest drift rather than a wrong record.

### 6. One parser

`scanBaselineNotation` now also returns `notations`, the in-zone notations that parsed, with their line and offset. Replay consumes that list, so a notation the static scan judges and the notation replay runs are the same parse. The `verify plan-structure` payload keys from ADR-4309 are unchanged.

## Consequences

- `verify plan-structure --replay` appends a `replay` key, `{ head_sha, results, mismatch_count, statuses }`, after the existing keys.
- The Criterion Replay Module (`src/criterion-replay.cts`) is pure. Execution is injected, so every quarantine rule is testable without spawning.
- The Shell Command Projection Module gains `execArgvQuarantined`. `execTool` and `execGit` are unchanged.

## Alternatives rejected

- **Reuse the `command-exit-zero` predicate.** It runs `sh -c`.
- **Reuse `execTool`.** It mediates `.cmd` files through `cmd.exe` with verbatim arguments, which is a shell by another name.
- **Allow `rg` and `wc`.** `rg --pre`, `rg -z` and `RIPGREP_CONFIG_PATH` can start other programs, and `wc --files0-from` reads arbitrary paths. The maintainer chose the smaller allowlist on 2026-11-08.
- **Mismatch as an error.** Issue #4310 condition 3 keeps replay advisory.
- **A capability-gated execution plugin** (triage Lens B). This is one opt-in flag on an existing verb, the same placement as #4288.
- **Echo stdout in the payload.** That would let a plan copy file content into tool output.

## Known limits

- Replay measures the working tree, not a clean checkout of `HEAD`, so uncommitted edits change the observed value.
- Pipelines, globs and every program other than `grep` and the four `git` subcommands are `disallowed`, never replayed.
- A pattern argument that starts with `/` or contains a `..` segment is reported `disallowed`, even though it is not a path.
- The quarantine constrains which program runs and with what arguments. It is not an OS sandbox. A symlink met during `-r` recursion is not resolved, though GNU grep does not follow such symlinks. The user's own git configuration (for example `core.fsmonitor`) applies as it does to every git call the tool makes.
