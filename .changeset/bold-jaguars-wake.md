---
type: Fixed
pr: 6465
---
**`commit --files` and `commit-to-subrepo --files` stage a path that starts with `-` as a path, not a git option** — `git add` ran without `--`, so an existing file named `-A` staged the whole working tree (or the whole sub-repo) into the commit and one named `-n` staged nothing yet exited 0; each declared path now reaches `git add` after `--`. (#6256)
