---
type: Fixed
pr: 2085
---
**`validate health` accepts the `adaptive` model profile and flags invalid `models.<phase_type>` tiers (new W022)** — `adaptive` was false-flagged by W004, and mistyped tiers were silently ignored by the resolver with no diagnostic.
