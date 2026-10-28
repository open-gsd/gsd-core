---
type: Fixed
pr: 5781
---
**A red `next` no longer blocks its own fix-forward in the merge queue, and a re-run no longer opens the gate by accident** — the `Base branch health` check now reads the `fix-next` label back from the API on `merge_group` runs (honoured only for a single-PR group whose label was applied by a collaborator with write access), treats an in-flight push run or re-run of a failed run as red instead of reading the older green run, and runs its script from the merge group's base sha rather than the queued commit.
