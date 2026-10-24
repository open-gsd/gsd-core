---
type: Fixed
pr: 5126
---
**A plain `query dispatch-isolation` re-query no longer clobbers a degrade that mandated sequential execution, so the isolation guard stops denying the dispatch the degrade itself asked for** — the #683 worktree base-check degrade is now re-derived by the resolver on every call that names no plan, as the `use_worktrees` opt-out has been since #3737, so a repo whose HEAD has diverged from its fork base keeps recording `none` across later plain queries (#4222); and a `none` that a dispatch site records with `--force-isolation none`, which the resolver cannot re-derive, is held by a later plain query in its scope while it is fresh (#4561). (#4904)
