---
type: Fixed
pr: 0
---
**The configuration reference now lists `workflow.specless_probe_fallback` and `hooks.commit_types`, and says which `parallelization` keys `config-set` accepts** — `docs/CONFIGURATION.md` had no row for either key, and its parallelization table did not say that `config-set parallelization.max_concurrent_agents` is refused (only the flat `parallelization` shorthand is settable; sub-keys are set by editing `.planning/config.json`). (#6735)
