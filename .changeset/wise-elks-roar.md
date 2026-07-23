---
type: Fixed
pr: 2571
---
smart-entry: parse the leading date from `last_activity` so the idle/staleness detector fires when the value carries a " — description" suffix (the shape STATE.md uses). Previously `Date.parse` on the whole string returned NaN and staleness failed open to false.
