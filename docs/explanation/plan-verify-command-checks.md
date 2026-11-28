# Why plan verify commands are checked the way they are

A planner writes the commands a plan will later use to verify its own work, and GSD cannot fully trust them. Two checks answer how far to go: path grounding for the commands that name a directory, and a stated failing direction for the commands that must be able to fail. What each does is in [feature 161](../FEATURES.md#161-verify-command-path-grounding) and [feature 167](../FEATURES.md#167-stated-failing-direction).

## Why path grounding is a recognizer, not a shell parser

Interpreting shell would mean maintaining a bad shell. Exactly two forms are grounded — a leading `cd <literal>` chain and `npm --prefix <literal>` — and any path carrying a variable, glob, substitution, or `~` returns `unresolvable`, which is a warning and never a blocker. The parser's incompleteness is the specification: it degrades to "cannot prove" rather than growing features. Refusing to guess is the fix, not a limitation of it.

## Why a stated failing direction, and not the two obvious alternatives

*Validating command shape* — teaching the checker Cargo's `--lib`/`--bin` target resolution, then pytest's node-ids, then the next one — always trails the newest toolchain. *Executing each command at plan time* is the strongest signal but means running planner-invented commands, with whatever side effects they carry, during planning. Requiring a stated failing direction needs no toolchain knowledge at all, and it is the only one of the three that catches the dangerous case: the motivating command exited non-zero, so it failed loudly, but the same class of error with a command that exits 0 on a no-op passes green and silently. Naming the failure signal is what makes that visible.
