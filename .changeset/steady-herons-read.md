---
type: Fixed
pr: 5502
---
**`config-get commit_docs` now reports the value the runtime uses** — after `config-set planning.commit_docs false`, `config-get commit_docs` read "Key not found", so the workflow gates that read it (`/gsd-quick`'s pre-dispatch commit, `/gsd-new-milestone` and eight others) fell back to committing `.planning/` files. `commit_docs` and `search_gitignored` now read back the resolved value under either spelling (`commit_docs` or `planning.commit_docs`), including a gitignored `.planning/` resolving `commit_docs` to false, so the `/gsd-settings` integrations screen also shows a nested `planning.search_gitignored: true` correctly. (#5470)
