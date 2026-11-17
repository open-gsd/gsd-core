---
type: Fixed
pr: 0
---
**Onboarding's summary commit now triggers the opt-in graph rebuild** — it committed through `gsd_run --cwd "$ONBOARDING_ROOT" query commit`, a global-flag form the graphify hook intentionally does not recognize, so no rebuild ran after onboarding. The workflow now changes into the onboarding root and runs the unflagged `gsd_run query commit`, so the existing gated rebuild (opt-in, default branch, CI, binary, live lock) runs against the onboarded checkout. (#5935)
