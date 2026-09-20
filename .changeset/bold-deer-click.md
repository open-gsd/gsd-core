---
type: Fixed
pr: 4825
---
**TDD red evidence accepts Surefire/Failsafe XML** — the tdd-red-evidence gate parsed only node:test TAP, so a JVM project's genuine Maven red scored INVALID_RED while hand-written synthetic TAP scored RED_EVIDENCE_OK (the gate was passable only by fabricating its input). Surefire/Failsafe XML reports now classify by tag-boundary scanning: a testcase with a <failure> or <error> child for the target class is a real red; self-closing passing cases are never spanned into failing names. (#4724)
