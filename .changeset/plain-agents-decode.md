---
type: Fixed
pr: 6183
---
**The debugger-spawn check reads dollar-quoting** — `claude --agent $'gsd-debugger'`, `$'gsd\x2ddebugger'`, `$"gsd-debugger"` and a launch inside a `bash -c $'…'` body or an `eval $'…'` operand are now denied as `debugger-cli-spawn`, as the unquoted name already was. The check reads a command the way the secret-read scan does: under bash's, zsh's and dash's readings, then the plain one, for any command that, once its `\<newline>` continuations are joined, holds `$'`, `$"`, `$${` or `$$(`, or a quote together with `((` or `$[`. That test is made again on each substitution body, `eval` operand and `bash -c` body the scan reads. Any other command, none of whose bodies holds one either, is scanned exactly as before. (#5441)
