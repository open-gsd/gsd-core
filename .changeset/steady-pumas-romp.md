---
type: Changed
pr: 6572
---
**Optional phase-end test gate for `/gsd-execute-phase`**. Set `workflow.defer_wave_tests` to run the test suite once at the phase regression gate while keeping each wave's build check. The option defaults to off.
