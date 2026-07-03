# Interface versioning and deprecation policy

This explains how the GSD Host-Integration Interface (ADR-1239) evolves over
time — what is an additive change, what is breaking, how `PROTOCOL_VERSION`
bumps, and what deprecation window host-plugin authors can rely on. The policy
exists because a published SDK is a long-term compatibility commitment (Hyrum's
Law: once external hosts depend on it, the observable behavior is the contract).

---

## The version knob: `PROTOCOL_VERSION`

`PROTOCOL_VERSION` is a positive integer carried by the engine and exchanged in
every negotiation (in-process and serialized). It governs the negotiated
capability **set** — which axes, values, and adapter shapes exist. A host
declares the version it targets; the engine negotiates down to
`min(host, engine)` and warns when a host declares a newer version than the
engine (capabilities beyond the engine's version are not trusted).

## Additive vs. breaking

- **Additive (no version bump required):** adding a new *optional* axis value, a
  new adapter option, or a new reference profile. Existing host-plugins keep
  working — the engine negotiates to their declared version and ignores
  unknowns. Additive changes are the default; the interface prefers growing the
  vocabulary over changing it.

- **Breaking (requires a `PROTOCOL_VERSION` bump):** removing or renaming an
  axis, changing an adapter's call/return shape, changing the negotiation result
  shape, or narrowing a value set. A breaking change is never silent — it lands
  behind a version bump so a host that declares the old version negotiates down
  and gets a warning, not a crash.

## Deprecation window

A value or adapter shape is **deprecated**, not removed, for at least **one
minor release cycle**. During the window:

1. The old form still works at its declared version.
2. The reference docs mark it deprecated with the successor + the removal version.
3. The negotiation emits a `warnings` entry when a host uses a deprecated value.

Removal is a breaking change and follows the version-bump rule above. The
`undocumented` sentinel is never deprecated — it is the permanent fail-closed
fallback for a host that omits an axis.

## What this means for host-plugin authors

- Pin to a `PROTOCOL_VERSION` and assert on it in your host-plugin's test.
- Treat unknown axis values / adapter options as additive (ignore, don't crash).
- Watch negotiation `warnings` — they surface both "host declared a newer
  version" and "host used a deprecated value."
- The serialized handshake's consistency with the in-process negotiation is
  itself part of the contract: a change that breaks that consistency is breaking.

## See also

- [Reference: the Host-Integration Interface](../reference/host-integration-interface.md)
- ADR-1239 (Status: Accepted)
