---
type: Fixed
pr: 6711
---
**A pytest fixture or collection error can no longer pass as RED evidence** — `check tdd-red-evidence` returned RED_EVIDENCE_OK when the only failing entry of a pytest `--junitxml` report was a collection crash or a fixture that failed in setup or teardown; it now returns INVALID_RED (`fixture_or_load_failure`). A test-body failure followed by a teardown error on the same test is accepted as RED evidence, and Surefire/Failsafe `<error>` entries classify as before. (#6641)
