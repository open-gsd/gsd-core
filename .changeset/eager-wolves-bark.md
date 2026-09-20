---
type: Fixed
pr: 4889
---
**check.decision-coverage-plan stops answering an unmeasured shape** — on could-not-parse it reported covered: 0 / uncovered: [] (fields of a measurement that never happened) and a directory passed as the context path certified passed: true; the gate now answers covered: null / total: null with the unreadable decision ids (and omits uncovered), and a non-file context path fails closed naming the path. (#4794)
