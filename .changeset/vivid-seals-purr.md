---
type: Added
pr: 1690
---
**Host-Integration Interface (ADR-1239 Phase A)** — a versioned, negotiated capability contract (`runtime.hostIntegration`) over the six host-integration points (command, dispatch, model, hooks, state, artifact). Adds an in-process `negotiateHostCapabilities` handshake that fail-closes on undeclared/unknown/`undocumented` values (`effective ⊆ host-declared ∩ engine-known`), a typed degradation ladder, host-capability profiles, and a documentation-sourced per-CLI capability matrix for all 16 runtimes. Interface-definition only — no change to install behaviour.
