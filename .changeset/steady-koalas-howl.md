---
type: Fixed
pr: 4701
---
**TDD RED evidence now routes by the actual runner and supported format** — Node TAP and Maven Surefire/Failsafe XML retain mandatory classifier validation, including Node reporter reruns and current-run XML checks. Other identified runners such as Vitest use direct assertion inspection with its self-attestation limits documented; unresolved runners stop before GREEN.
