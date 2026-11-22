---
type: Fixed
pr: 0
---
**The Bash guard denies `claude --agent {gsd-debugger,x}` and its brace-expanded spellings** — the debugger-spawn check judged the `--agent` value as written, so bash brace expansion (`{gsd-debugger,x}`, `gsd-{debugger,x}`, `--agent={x,gsd-debugger}`, a plugin-namespaced alternative) hid a `gsd-debugger` launch and the command was allowed; the value is now judged by every alternative it expands to, a quoted word is judged as written, and brace lists that only name other agents stay allowed. (#6439)
