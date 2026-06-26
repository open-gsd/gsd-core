# How to add or update a host's integration capabilities

This guide is for GSD maintainers adding a new host CLI, or updating an existing host's
host-integration axes (ADR-1239 Phase A). It covers the **documentation-sourcing rule**, the
eight `runtime.hostIntegration` axes, the `undocumented` sentinel, and how to validate.

The governing rule for this whole process: **every axis value must come from the host's own
authoritative documentation. Never infer, guess, or assume.** Where the docs do not state an axis,
record the explicit `undocumented` sentinel — not a plausible default. The reference matrix
(`docs/reference/host-integration-capability-matrix.md`) is the source of truth, and every value in
it carries a citation and an evidence quote.

---

## 1. Find the host's authoritative documentation

In order of preference:

1. **Context7** — `resolve-library-id` for the host, then `query-docs` for "plugins / subagents / hooks / commands / MCP / model API".
2. **Official dev docs / source repo** — the host's documentation site or GitHub repo (plugin API, agents, hooks, MCP, command authoring).

Capture the exact source (Context7 library id + query, or the doc URL) and a short verbatim quote
for each value you determine. You will paste these into the matrix in step 4.

## 2. Determine each of the eight axes from the docs

Read the docs and map them to the closed vocabulary. Do not pick a value unless a source states it.

| Axis | What to look for in the docs |
|---|---|
| `embeddingMode` | An in-process programmatic plugin/extension API (`imperative`) vs. configuration files only (`declarative`). |
| `commandSurface` | How custom commands are authored/invoked: `slash-file` (.md), `slash-toml`, `slash-programmatic`, `palette`, `prose-only`. |
| `dispatch` | Sub-agent delegation: `namedDispatch`, `nested`, `maxDepth` (int; `-1` = documented-unbounded), `background`, `subagentToolkit` (`full`/`read-only`). |
| `modelMode` | A programmatic model request/provider API (`active`) vs. instruction/per-agent-field only (`passive`). |
| `hookBus` | The host fires lifecycle events a plugin subscribes to (`host`), an extension host owns the bus (`engine`), or no bus (`none`). **Independent of `hooksSurface`** — e.g. opencode has `hooksSurface: none` but `hookBus: host`. |
| `stateIO` | `filesystem`, `sandboxed-storage` (web IDE, no arbitrary FS), or `session-log-append`. |
| `transport` | `mcp` (native MCP support) vs. `native-extension` (MCP needs a community extension). |
| `runtime` | The plugin/extension runtime: `node`, `bun`, `sandboxed-web`, `python`, `go`, `rust`, `electron`, `other`. |

## 3. Write the `runtime.hostIntegration` block

In `capabilities/<id>/capability.json`, inside the `runtime` object, add (or edit) the block. Use a
documented closed-vocabulary value, or the literal string `"undocumented"` for any axis the docs do
not state:

```json
"hostIntegration": {
  "embeddingMode": "declarative",
  "commandSurface": "slash-file",
  "dispatch": { "namedDispatch": true, "nested": false, "maxDepth": 1, "background": false, "subagentToolkit": "undocumented" },
  "modelMode": "passive",
  "hookBus": "host",
  "stateIO": "filesystem",
  "transport": "mcp",
  "runtime": "node"
}
```

**When to use `undocumented`:** only when you searched and the host's docs genuinely do not state the
axis. It validates, but `negotiateHostCapabilities` **fail-closes** on it (degrades to the most
restrictive known value) — so it is always safe and never a silent capability claim. A dispatch
boolean or `maxDepth` may also be `"undocumented"`.

**Do not conflate the orthogonal axes:** `commandStyle` (GSD's emission style) is *not*
`commandSurface` (the host's surface type); the `hookEvents` dialect is *not* `hookBus` (bus
ownership); `runtimeCompat` (which features run on a host) is independent of these runtime→engine
axes.

## 4. Record the citations in the reference matrix

Add (or update) the host's section in `docs/reference/host-integration-capability-matrix.md` with a
row per axis: `Axis | Value | Source | Evidence`. For an `undocumented` value, put the search trail
in the Source column. This file is the deployment source of truth — a value without a citation here
is not allowed.

## 5. Validate

```bash
npm run build:lib
npm run gen:capability-registry   # validateRuntimeBody runs on every descriptor
```

`gen:capability-registry` must succeed with zero errors. The validator
(`gsd-core/bin/lib/capability-validator.cjs`) rejects out-of-vocabulary values, malformed dispatch
structs, and reserved keys (`__proto__`/`constructor`/`prototype`).

Then run the host-integration tests and the full cross-platform suite:

```bash
node --test tests/host-integration-descriptors.test.cjs   # asserts every descriptor validates + profiles
gsd-test-both                                              # Mac + Linux Docker (run before any PR)
```

## 6. If you need a vocabulary value that does not exist yet

The vocabulary is intentionally **closed** (ADR-857 Decision 8): a genuinely new host shape requires
a first-party primitive, reviewed. To add one (e.g. a new `runtime` kind):

1. Add the value to the relevant axis in `HOST_INTEGRATION_AXES` in `src/host-integration.cts`.
2. Add the same value to the matching `VALID_*` set in `capability-validator.cjs`.

The parity guard (`tests/host-integration-validator-parity.test.cjs`) fails if these two drift, so
they must be updated together. Document the new value's meaning in the matrix legend.

---

## Related

- Reference: [`docs/reference/host-integration-capability-matrix.md`](../reference/host-integration-capability-matrix.md) — the per-CLI sourced values.
- ADR: [`docs/adr/1239-gsd-embeddable-orchestration-engine.md`](../adr/1239-gsd-embeddable-orchestration-engine.md) — why the interface exists and the Phase A amendment.
- The closed-vocabulary runtime descriptor it extends: [ADR-1016](../adr/1016-runtime-capability-descriptor.md).
