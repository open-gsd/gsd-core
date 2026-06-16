---
type: Fixed
pr: 1133
---
**`model_policy` is now honored on the default `claude` runtime** — including the `anthropic-fable` Claude Fable 5 preset. Policy-resolved model IDs map to Claude Code agent aliases (e.g. `claude-fable-5` → `fable`), and IDs without a Claude alias warn and fall back to the configured tier. Forward-port of #1133 (originally shipped on the 1.4.5 hotfix line). (#1133)
