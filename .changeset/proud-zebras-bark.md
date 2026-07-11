---
type: Added
pr: 2175
---
**Opt-in compact GSD-state statusline format** — new `statusline.state_format` config, enum `full`|`compact` (default `full`, the existing rendering). `compact` renders "<version> · P<phase>/<total> · <status>" (e.g. "v1.12 · P7/12 · executing"), dropping the milestone name and progress bar and collapsing narrative statuses to the canonical vocabulary from `normalizeStateStatus()` — the canonical stuck state `paused` renders uppercase as `PAUSED`. Solves the unbounded-width problem where free-text status sentences push the context meter off the line. Resolves #2162.
