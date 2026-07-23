---
type: Added
pr: 2519
---
**New `kimi-code` runtime (Node Kimi Code CLI) registered as a distinct EoS capability** — Kimi Code users running `--kimi --global` were silently installing the Python kimi-cli agent YAMLs (which Kimi Code ignores) and getting an empty `gsd-tools query agent-skills` response. The split adds a `kimi-code` descriptor with `runtime: "node"`, `dispatch.namedDispatch: false`, `builtInSubagents: [coder, explore, plan]`, and registers it across every drift-guarded surface (allRuntimes, runtimeMap, FALLBACK_ALIASES, RUNTIME_LABELS, model-catalog, runtime-aliases manifest, capability-registry, capability-matrix, CONTEXT.md glossary). `runtimeFlags('kimi-code').isKimiCode === true`; `--kimi-code` selects kimi-code without interactive prompt; existing `kimi` (Python kimi-cli) users see no behavior change beyond the corrected `localConfigDir: ".kimi"`. (#2511)
