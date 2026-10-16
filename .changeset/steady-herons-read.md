---
type: Fixed
pr: 0
---
`gsd-tools query config-get commit_docs` and `config-get planning.commit_docs` now return the commit policy the runtime applies: the flat key, then the nested `planning.commit_docs`, then a gitignored `.planning/`, then the default. After `config-set planning.commit_docs false`, the workflow gates that read it (`/gsd-quick`'s pre-dispatch commit, `/gsd-new-milestone`, and eight others) no longer fall back to committing `.planning/` files (#5470)
