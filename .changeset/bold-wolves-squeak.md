---
type: Added
pr: 5722
---
**/gsd-complete-milestone tags and archives each repository's release separately** — with `git.repo_tagging: per_repo` and `planning.sub_repos`, milestone completion collects a release map, checks every tag before creating any, creates local annotated tags in each repository, and asks a separate question naming the repository and remote before pushing a tag; nothing is pushed by default. (#3628)
