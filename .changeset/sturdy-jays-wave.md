---
type: Fixed
pr: 5634
---
**A flaky test no longer fails on a randomly drawn help flag** — the stall-detection property test could generate `-h` for `config-set`, which the dispatcher treats as a help request (usage, exit 0, no write), so it failed on some seeds. The generator now excludes dispatcher help tokens and the contract is pinned with fixed examples; the dispatcher is unchanged. (#5507)
