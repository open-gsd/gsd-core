---
type: Fixed
pr: 312
---
Index argv once in parseNamedArgs instead of re-scanning per flag (O(flags*argv) -> O(argv+flags)) (#312).
