---
type: Fixed
pr: 5055
---
**`gsd-tools check tdd-red-evidence` now recognizes a genuine swift-testing failure** — a real red from `swift test` was silently misreported as zero tests discovered, permanently blocking the TDD gate's RED-to-GREEN transition. (#4957)
