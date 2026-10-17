---
type: Fixed
pr: 5472
---
`/gsd-docs-update --verify-only` no longer asks questions it discards, the doc verifier's result files are written under the project root and named by the doc's full relative path (so two `README.md` files no longer overwrite each other, and a run in a git worktree no longer writes into the main checkout), and verifier spawns are batched under the host's dispatch capacity.
