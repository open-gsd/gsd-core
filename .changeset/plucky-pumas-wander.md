---
type: Fixed
pr: 6261
---
**The shared test-project fixture no longer follows the host's `init.defaultBranch`** — its repo now starts on `master` regardless of the developer machine's git config, so tests that ask about `master` (K2, #4834) pass locally on a stock macOS git as they do on CI. (#5913)
