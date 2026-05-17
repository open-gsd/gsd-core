---
type: Added
pr: 0
---
**Release v1.45.0 — Vertical MVP Slice mode (#2826)** — cuts the GA release for the MVP umbrella. Bumps version 1.50.0-canary.0 → 1.45.0 across `package.json`, `package-lock.json`, `sdk/package.json`, and `sdk/package-lock.json`. Adds the `[1.45.0]` section to `CHANGELOG.md` rolling up the five MVP sub-phases that landed via #3206 (mislabeled as an OpenCode fix). Cherry-picks the user-facing MVP documentation from #3180 into `docs/USER-GUIDE.md`, `docs/COMMANDS.md`, and `docs/CLI-TOOLS.md` so the feature is discoverable outside `references/` and `CHANGELOG.md`. Adds `docs/RELEASE-v1.45.0.md`. Closes #2885, #2875, #2877, #2879, #2882 in their "release-machinery" sense (the implementation PRs #2867, #2874, #2878, #2880, #2883 are already merged via #3206).
