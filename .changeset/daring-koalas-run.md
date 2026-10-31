---
type: Added
pr: 5813
---
**The secret-read guard can fail closed on its own failure** — with `GSD_SECRET_READ_GUARD_ON_CRASH=deny` in the runtime's environment, a hook error, or a stdin that does not close within 3 s, is blocked as `guard-error` instead of allowed, so a host that registers the guard with `onFailure: "block"` no longer has a failure path that lets a read through. Unset, or any other value, keeps the fail-open default. (#5784)
