---
type: Fixed
pr: 123
---
**Escape `/` in `forensics.test.cjs` regex literals** — two regexes at lines 153 and 163 contained unescaped `/` characters in `open-gsd/get-shit-done-redux`, causing a `SyntaxError: Invalid regular expression flags` at parse time on all platforms and blocking CI for every PR on the affected main state. Closes #3855.
