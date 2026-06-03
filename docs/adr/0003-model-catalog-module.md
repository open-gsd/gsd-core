# Model Catalog Module as single source of truth for agent profiles and runtime tier defaults

- **Status:** Accepted
- **Date:** 2026-05-07

We decided to centralize model-selection data in one Model Catalog Module so the SDK, the CLI/CJS layer, and the docs do not maintain separate agent lists, profile maps, or runtime tier defaults.

## Problem

Before this ADR there were four drifting sources:

1. `gsd-core/bin/lib/model-profiles.cjs` — agent → profile alias map, phase-type map, dynamic-routing default tiers
2. `sdk/src/query/config-query.ts` — stale 18-agent copy of `MODEL_PROFILES`
3. `gsd-core/workflows/settings-advanced.md` — runtime → built-in model-id table
4. `sdk/src/session-runner.ts` — hardcoded Claude-only profile → model-id map

This caused issue #3229: the SDK knew only 18 agents while 33 agent files existed on disk, so ~15 agents silently fell back to Sonnet with `unknown_agent: true`.

## Decision

Create one machine-readable catalog and derive everything else from it.

The catalog owns:
- supported runtime names
- runtime tier defaults (`opus` / `sonnet` / `haiku`) and runtime capabilities (e.g. `reasoning_effort` support)
- the full agent registry for model resolution
- the canonical per-agent **golden** alias (quality intent)
- derived profile aliases for `balanced`, `budget`, and `adaptive`
- agent → phase-type mapping
- agent → dynamic-routing default tier mapping

The canonical file lives in a location both packages ship:
- repo root package (`@opengsd/get-shit-done-redux`) includes it
- standalone SDK package (`@opengsd/gsd-sdk`) includes it

Both CJS and SDK load this exact file. Neither package keeps its own independent list.

## Golden profile

The catalog stores a `golden` alias per agent. `quality` is defined as the golden profile exactly. Other profiles (`balanced`, `budget`, `adaptive`) are explicit views over the same agent registry. This keeps the highest-quality intent in one place while allowing lower-cost profiles to differ per agent where needed.

## Consequences

- `resolve-model` in SDK and CJS read the same registry, so missing-agent drift disappears
- `settings-advanced.md` runtime tier table must stay in parity with the catalog (enforced by test)
- `sdk/src/query/helpers.ts` runtime list comes from the catalog, fixing drift like the missing `hermes` runtime
- `sdk/src/session-runner.ts` uses the catalog's Claude runtime tier defaults instead of a private hardcoded profile map
- tests validate:
  - every `agents/gsd-*.md` file exists in the catalog
  - SDK and CJS resolve the same aliases for all known agents
  - unknown-agent fallback follows profile semantics (`quality`→`opus`, `budget`→`haiku`, etc.), not a hardcoded `sonnet`
  - docs/runtime tables stay aligned with the catalog
