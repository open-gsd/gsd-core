---
type: Fixed
pr: 408
---
`ci-test-scope.cjs` now matches the #370/#395 changeset: drops the unconditional `DEFAULT_SMOKE_TESTS` injection on code-change, and falls back to the `unit` suite when the affected selection is empty.
