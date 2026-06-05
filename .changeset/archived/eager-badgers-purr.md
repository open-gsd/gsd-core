---
type: Changed
pr: 3158
---
**SDK Runtime Bridge seam deepened** — dispatch is now centralized behind a native-first Runtime Bridge Module with explicit fallback policy (allowFallbackToSubprocess), strict native-only mode (strictSdk), and structured dispatch observability events; architecture/ADR docs updated to reflect the seam.
