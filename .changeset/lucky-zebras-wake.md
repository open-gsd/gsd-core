---
type: Added
pr: 5835
---
**`/gsd-code-review` now reviews CI/CD pipeline files for reliability defects** — workflow files, Dockerfiles, compose files and deploy scripts were reviewed as generic text, so a missing job timeout, an unpinned action, a deploy with no rollback or a non-idempotent install reached merge unflagged. They now get their own rubric at standard/deep depth, and quick depth checks workflows for unpinned actions, `npm install` and jobs with no timeout. (#4101)
