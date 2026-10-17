---
type: Fixed
pr: 5475
---
The TDD gate no longer blocks Go projects: `go test` output is accepted as RED evidence (a run whose package fails to compile is refused as `build_failure`), and a task whose files are only Go, Elixir, RSpec or pytest test files is no longer treated as behavior-adding. The behavior-adding check and the RED-commit pathspec now share one test-file list.
