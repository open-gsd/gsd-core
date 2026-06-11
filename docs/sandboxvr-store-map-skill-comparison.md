# SandboxVR Store Map Skill Comparison

Date: 2026-06-11  
Linked issue: #1029

## Goal

Compare the application-code output for the same standalone feature under four implementation conditions:

1. gsd-core context + `modern-web-guidance` + `design-taste-frontend`
2. gsd-core context + `modern-web-guidance`
3. gsd-core context without `modern-web-guidance`
4. no superpowers and no gsd-core context

Shared product requirement held constant across all scenarios:
- standalone new app, not integrated into existing CLI/SDK packages
- placeholder interactive map surface
- SandboxVR store listing
- detail panel updates on selection/click
- per-store click counts persisted to local SQLite

## Collected artifacts

| Scenario | Branch source | Collected path |
|---|---|---|
| 1 — gsd + modern + taste | `poc-store-map-s1-gsd-modern-taste` | `examples/skill-comparison/scenario-1-gsd-modern-taste/` |
| 2 — gsd + modern | `poc-store-map-s2-gsd-modern` | `examples/skill-comparison/scenario-2-gsd-modern/` |
| 3 — gsd without modern | `poc-store-map-s3-gsd-no-modern` | `examples/skill-comparison/scenario-3-gsd-no-modern/` |
| 4 — no superpowers / no gsd | `poc-store-map-s4-no-super-no-gsd` | `examples/skill-comparison/scenario-4-no-super-no-gsd/` |

## Parent verification

All four scenarios were re-run from the parent session after implementation.

| Scenario | Test command | Result | Smoke command | Result |
|---|---|---:|---|---:|
| 1 | `cd examples/skill-comparison/scenario-1-gsd-modern-taste && npm test` | 6 pass / 0 fail | `npm run smoke` | pass |
| 2 | `cd examples/skill-comparison/scenario-2-gsd-modern && npm test` | 5 pass / 0 fail | `npm run smoke` | pass |
| 3 | `cd examples/skill-comparison/scenario-3-gsd-no-modern && npm test` | 4 pass / 0 fail | `npm run smoke:click` | pass |
| 4 | `cd examples/skill-comparison/scenario-4-no-super-no-gsd && npm test` | 5 pass / 0 fail | `npm run smoke` | pass |

### Smoke outputs observed

- Scenario 1: `san-francisco` count persisted from `0 -> 1`
- Scenario 2: `austin-tx` count persisted from `0 -> 1`
- Scenario 3: `sandboxvr-san-francisco` count persisted from `0 -> 1`
- Scenario 4: `sandboxvr-austin` count persisted from `0 -> 1`

## Comparison table

| Scenario | Stack | App placement choice | UI/result characteristics | DB/logging | Observed trade-off |
|---|---|---|---|---|---|
| 1 — gsd + modern + taste | Node HTTP + vanilla JS + SQLite (`better-sqlite3`) | Final collection under `examples/skill-comparison/` (original lane chose `experiments/`) | Most polished visual treatment: hero section, glassmorphism, richer marker styling, stronger layout hierarchy | SQLite persisted click counts | Best presentation quality, but also the messiest lane operationally — initial worker timed out and needed parent repair/normalization |
| 2 — gsd + modern | Node HTTP + vanilla JS + SQLite (`better-sqlite3`) | `examples/` | Clean semantic structure, accessibility-minded controls, more progressive-enhancement-oriented layout | SQLite persisted click counts | Best balance of restraint, clarity, and clean delivery |
| 3 — gsd without modern | Node HTTP + vanilla JS + SQLite (`better-sqlite3`) | `examples/` | Most utilitarian repo-aware implementation; functional but less refined in UI and frontend structure | SQLite persisted click counts | Lean and reliable, but clearly less frontend-forward |
| 4 — no superpowers / no gsd | Node HTTP + vanilla JS + SQLite (`better-sqlite3`) | `examples/` | Control implementation: self-contained, straightforward, less shaped by repo/process conventions | SQLite persisted click counts | Good control baseline; simpler isolation mindset but less aligned to repo-aware conventions |

## Recommendation

Carry forward **Scenario 2 (`gsd-core` context + `modern-web-guidance`)**.

Why:
- It stayed disciplined about repo-aware isolation without overfitting to existing packages.
- It delivered clean accessibility/semantic structure and modern frontend choices without introducing unnecessary complexity.
- It verified cleanly with less rescue work than Scenario 1.
- It kept the dependency footprint small while still producing a credible standalone app.

## Notable observations

1. **`modern-web-guidance` mattered more than repo context for frontend quality.**
   The biggest visible difference was semantic structure, interaction quality, and layout refinement.
2. **`design-taste-frontend` improved polish, but increased variance.**
   Scenario 1 produced the most visually ambitious output, but it was also the only lane that required parent-side repair after timeout.
3. **Repo context mostly affected placement and discipline.**
   The gsd-aware branches were more deliberate about isolation and compatibility with the repo layout.
4. **All scenarios converged on the same practical backend shape.**
   Placeholder-map + Node server + SQLite was the stable lowest-complexity solution for this experiment.

## Caveats

- The tracking issue was created as #1029, but the available token could not apply the `approved-feature` label (`403 Forbidden`). This may cause repository automation or reviewer policy friction on the PR.
- These are comparison artifacts, not integrated product surfaces in the main GSD runtime.
- Scenario 1 was repaired in the parent session after the implementation worker timed out; the final artifact in this branch reflects the repaired version that passed verification.
