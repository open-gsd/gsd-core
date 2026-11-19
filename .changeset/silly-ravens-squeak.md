---
type: Added
pr: 0
---
**`gsd-tools project-context` reports how it found the git layout, and most commands no longer start `git` to find the project** — `provenance.layout` is `filesystem` when the checkout, the main checkout and the shared git dir were read from `.git`, `gitdir` and `commondir`, and `git` when `git rev-parse` was asked. A plain checkout, a linked worktree of a non-bare repository and a directory outside any repository are now read from the filesystem, which removes one `git` process (two in a linked worktree) from every `gsd-tools` call there. (#6355)
