---
type: Added
pr: 177
---
**Observability seam for Hub dispatch (#177)** — the Command Routing Hub now accepts an injected `DispatchLogger`. Default behaviour is silent on success and emits a structured JSON line to stderr on error. Opt-in file audit at `.planning/.gsd-trace.jsonl` is enabled via `GSD_AUDIT=1` env var or `config.audit.enabled: true`. Args are excluded from every emitted event by default (privacy); `GSD_AUDIT_ARGS=1` opts in.
