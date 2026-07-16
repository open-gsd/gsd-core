---
type: Security
pr: 0
---
**`phases.clear --archive-version` and `milestone complete <version>` now reject version labels containing path separators or `..`** — the milestone version becomes a filesystem directory name that phase directories are moved into, so an unvalidated value could relocate phase history outside `.planning/milestones/`. Both now validate against a strict version-token pattern and fail loudly. (#2288)
