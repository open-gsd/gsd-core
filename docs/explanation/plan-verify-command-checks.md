# Why plan verify commands are checked the way they are

A planner writes the commands a plan will later use to verify its own work, and GSD cannot fully trust them. Two checks answer how far to go: path grounding for the commands that name a directory, and a stated failing direction for the commands that must be able to fail. What each does is in [feature 161](../FEATURES.md#161-verify-command-path-grounding) and [feature 167](../FEATURES.md#167-stated-failing-direction).

## Why path grounding is a recognizer, not a shell parser

Interpreting shell would mean maintaining a bad shell. Exactly two forms are grounded — a leading `cd <literal>` chain and `npm --prefix <literal>` — and any path carrying a variable, glob, substitution, or `~` returns `unresolvable`, which is a warning and never a blocker. The parser's incompleteness is the specification: it degrades to "cannot prove" rather than growing features. Refusing to guess is the fix, not a limitation of it.

## Why a stated failing direction, and not the two obvious alternatives

*Validating command shape* — teaching the checker Cargo's `--lib`/`--bin` target resolution, then pytest's node-ids, then the next one — always trails the newest toolchain. *Executing each command at plan time* is the strongest signal but means running planner-invented commands, with whatever side effects they carry, during planning. Requiring a stated failing direction needs no toolchain knowledge at all, and it is the only one of the three that catches the dangerous case: the motivating command exited non-zero, so it failed loudly, but the same class of error with a command that exits 0 on a no-op passes green and silently. Naming the failure signal is what makes that visible.

## Why a command that parses is checked separately from a command that detects (#4586)

A stated `<fails_when>` (#3172) shows the planner understands what a check should detect. It cannot show that the command parses. In the motivating T-SQL phase every plan satisfied the `<fails_when>` contract and three still shipped commands that could not run: an unaliased derived-table column (`Msg 8155`), `CONCAT()` with one argument, and a batched query that never returned. Each executor then had to decide whether the check or the deliverable was wrong, and the wrong answer, adjusting the deliverable until the check passes, silently corrupts the thing being verified.

**The sanctioned set is closed, and it is smaller than it looks.** Validate-only means the form does not run the body, does not write to the tree, does not need the command's targets to exist, and needs no network or install. `bash -n`, `node --check`, a `python3` `ast.parse` one-liner, `SET PARSEONLY ON` (T-SQL, with a live session) and `cargo metadata --no-deps` (target shape) qualify. Four forms that read like validators do not, and the reference names them so the planner never reaches for them: `python -m py_compile` writes a `.pyc`; `cargo check` runs the crate's build scripts and procedural macros; `npm run <script> --dry-run` is ignored by `npm run` and executes the script; `terraform validate` needs an initialized directory.
