---
type: Security
pr: 665
---
**Hardened roadmap-phase parsing and config writes** — resolved ReDoS in phase-heading/plan-filename regexes (validate/verify/commands/phase), blocked prototype-pollution through dotted config keys in `config-set`, and pinned `qs >= 6.15.2` (DoS advisory).
