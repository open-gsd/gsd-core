---
type: Fixed
pr: 2309
---
**Runtime brand-swap no longer mislabels `<runtime_compatibility>` comparison tables** — every runtime installer that rebrands "Claude Code" to its own name (Cursor, Windsurf, Trae, Cline, CodeBuddy, Qwen, Hermes) also swapped it inside the runtime-comparison tables in shipped workflows, where "Claude Code" is a compared-runtime label, not a host self-reference — corrupting the comparison. Branding now protects `<runtime_compatibility>` regions while still rebranding genuine self-references. (#2284)
