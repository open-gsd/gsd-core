---
type: Changed
pr: 3152
---
**Command contract validation now enforced in CI (ADR-0002)** — \`scripts/lint-command-contract.cjs\` runs as a pre-test step and validates every \`commands/gsd/*.md\` file against five rules: \`name:\` present + \`gsd:\` prefix, \`description:\` non-empty, \`allowed-tools:\` entries canonical, \`execution_context\` @-refs resolve on disk, @-refs on their own line. Prevents the \`add-backlog.md\`-class gap from silently reappearing on consolidation PRs.

**~900 tokens/invocation recovered** — prose \`@~/.claude/get-shit-done/...\` path tokens removed from \`<process>\` blocks in 39 command files. The \`<execution_context>\` block is now the single authoritative load declaration; the duplicate prose copies were inert but consumed context on every command invocation.

**~3,750 tokens removed from eager session load** — \`/gsd-debug\` (9,603 → 1,703 chars) and \`/gsd-thread\` (7,868 → 585 chars) now follow the workflow-delegation pattern used by all other commands. Their implementations moved to \`get-shit-done/workflows/debug.md\` and \`get-shit-done/workflows/thread.md\`. Behavior is unchanged.

\`get-shit-done/workflows/extract_learnings.md\` renamed to \`extract-learnings.md\` to match the hyphen convention of all other workflow files. Closes #3151.
