# How to check recorded baselines by replaying them

**Goal:** Confirm that every `[HEAD=<value> EXPECT…]` baseline in a plan matches what its command actually prints now, before an executor runs the phase.

**Prerequisites:** A `PLAN.md` whose count/match gates carry the baseline notation (see [PLAN.md → Baseline notation](../reference/plan-md.md#baseline-notation)), and a project that is a git checkout. Replay is opt-in: nothing runs it for you. For why it is shaped this way, see [ADR-4310](../adr/4310-criterion-replay.md).

---

## 1. Run the replay

```bash
gsd-tools verify plan-structure .planning/phases/03-auth/03-01-PLAN.md --replay
```

The command runs each criterion's command at the project root and adds a `replay` key to the usual JSON verdict. Replay never changes the exit code. A plan that was valid stays valid, whatever replay finds.

## 2. Read the results

`replay.results` has one entry per command that ran:

- `outcome: "match"`: the command printed exactly the recorded `HEAD`. The baseline was measured.
- `outcome: "mismatch"`: it printed something else. `recorded` is what the plan says and `observed` is what the command printed. The same mismatch also appears in `warnings`.
- `rev_drift: true`: the notation is pinned (`@<sha>`) to a commit other than the current `HEAD`. The tree may have legitimately moved since the baseline was recorded.

## 3. Fix a mismatch

1. Run the command yourself and read what it prints.
2. If the plan's `HEAD` was a guess, replace it with the printed value. Then check the criterion still fails at HEAD. If the corrected `HEAD` already satisfies `EXPECT`, `verify plan-structure` now reports B1. Fix that as described in [Resolve baseline-notation findings](resolve-baseline-notation-findings.md).
3. If the command is not the one the criterion means (wrong path, wrong pattern), fix the command, then re-measure `HEAD`.
4. If `rev_drift` is true and the tree moved on purpose, re-measure and update the `@<sha>` pin.
5. Re-run with `--replay` until every result is `match`.

## 4. Tell "nothing to report" from "could not look"

| You see | It means |
|---|---|
| `results: []`, `statuses: []` | No judged notation in the plan. Nothing was replayed. |
| every result `match`, no statuses | Every recorded baseline was checked and holds. |
| statuses only | Notations exist, but none could be replayed. Their baselines are unchecked. |

Each status names why a notation was not replayed:

| `code` | Why | What to do |
|---|---|---|
| `no_command` | No backtick command before the notation, and no trailing `#` comment | Put the command in backticks on the notation's line, or put the notation in a trailing `#` comment after an `<automated>` command |
| `ambiguous_command` | Two or more backtick spans before the notation | Keep one command per notation line |
| `malformed_command` | An unclosed quote or a trailing backslash | Fix the quoting |
| `disallowed` | A pipe, redirect, glob, `$`, an absolute or `..` path, a program other than `grep`/`git`, a `git` subcommand other than `grep`, `ls-files`, `rev-parse` or `rev-list`, an option outside the allowlist (including abbreviations and `-f`/`-m` style options), or a path that resolves outside the project through a symlink | Rewrite the gate as one `grep` or `git` command if you can. Otherwise this gate cannot be replayed; its baseline stays a declared value |
| `cannot_run` | The program was not found, or it was killed | Install `grep` or `git`, or check the command |
| `timeout` | The command ran longer than 10 s | Narrow the search path |
| `output_cap` | The command printed more than 64 KiB | Use a counting flag (`-c`, `--count`) |
| `budget_exhausted` | The 60 s total budget ran out before this command | Split the plan, or narrow the slow commands |
| `truncated` | More than 50 commands or statuses; the rest are summarized | Expected on a very large plan |
| `replay_error` | Replay itself failed; static validation still ran | Report it as a bug |

## Limits

- Replay measures the working tree, not a clean checkout of `HEAD`. Commit or stash your edits first if you want the baseline at the commit.
- A pattern that starts with `/` or contains a `..` segment is reported as `disallowed`, even though it is not a path.
