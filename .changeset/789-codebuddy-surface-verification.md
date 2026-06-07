---
type: Changed
pr: 0
---
Document and regression-guard the CodeBuddy installer artifact surface. CodeBuddy already receives GSD subagent manifests (`~/.codebuddy/agents/`) and user-invocable skills that surface as `/gsd-*` slash entries in CodeBuddy's `/` menu; the layout source-of-truth (`src/runtime-artifact-layout.cts`) now documents why a parallel `commands/` kind and an `mcp.json` are intentionally not emitted (the commands surface would duplicate every `/gsd-*` skill entry, and GSD ships no MCP server). New tests lock the subagent-manifest emission and the user-invocable (slash-accessible) skill contract. (#789)

<!-- docs-exempt: internal documentation comment + installer regression tests; no user-facing behavior change (CodeBuddy already emits skills + agents). -->
