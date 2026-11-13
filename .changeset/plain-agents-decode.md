---
type: Fixed
pr: 0
---
**The debugger-spawn check reads dollar-quoting** — `claude --agent $'gsd-debugger'`, `$'gsd\x2ddebugger'`, `$"gsd-debugger"` and a launch inside a `bash -c $'…'` body or an `eval $'…'` operand are now denied as `debugger-cli-spawn`, as the unquoted name already was. The check reads a command holding dollar-quoting the way the secret-read scan does: under bash's, zsh's and dash's readings, then the plain one. A command that holds no dollar-quoting, before or after the scan unquotes its `eval` and `bash -c` operands, is scanned exactly as before. (#5441)
