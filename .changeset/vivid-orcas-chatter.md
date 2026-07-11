---
type: Added
pr: 1979
---
**`/gsd-ui-phase` now probes UI state coverage** — a new `ui-consideration-probe` (the third `probe-core` adapter) enumerates the shape-rooted UI states a UI-SPEC must resolve (empty/loading/error/populated/partial/overflow/zero-one-many/long-text). After the UI checker approves, the probe surfaces applicable considerations for each element, records a `## UI Considerations` section in the UI-SPEC, and plan-phase lifts each resolved consideration into `must_haves` — so a purely-visual state with no wired test routes to `insufficient_spec → human_needed` at verify rather than a silent pass.
