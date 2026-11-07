---
type: Fixed
pr: 5456
---
**Carry external lane evidence into `--fix --auto` re-reviews** — re-reviews now receive the external reviewer lane evidence the first review saw instead of silently dropping it after iteration 1 (#5019); the evidence is kept under the temp directory, keyed to the review file, and nothing is written into the project or its git metadata.
