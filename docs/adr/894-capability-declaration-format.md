# ADR-894: Capability declaration format + registry generation [Proposed]

- **Status:** Proposed
- **Date:** 2026-06-08
- **Issue:** #894
- **Parent:** ADR-857 (Capability system) — resolves its Open question #1
- **Phase:** ADR-857 rollout phase 3a (design-only)

## Context

[ADR-857](857-capability-system.md) decided the **Capability** model: the five-step loop is the privileged host; every other feature is a Capability declared co-located and compiled into a generated central **Capability Registry**, owning its skills, agents, hooks, federated config-key schema, and **Loop Extension Point** registrations. ADR-857 deliberately deferred one detail to phase 3:

> *"The exact on-disk shape of a co-located Capability declaration (folder layout, declaration format)."*

Building the generator, the federated config loader (phase 3b), and the loop seam (phase 3c) all depend on that format. Getting it wrong is expensive once capabilities and a generator exist. This ADR fixes the format **as a reviewable design**, with no code — the generator build is a separate sub-phase that implements this contract.

The repo already has the muscle this design leans on: co-located/source-of-truth → generated central artifact with a `--write`/`--check` drift gate, as in `scripts/gen-inventory-manifest.cjs` and `scripts/research-profiles.cjs`. The Capability Registry generator follows the same shape.

## Decision

### 1. Folder layout

A Capability is a directory under a top-level `capabilities/` tree:

```
capabilities/
  <id>/
    capability.json          # the declaration (this ADR's subject)
    # (future) skills/ agents/ hooks/ loop/    — co-located owned artifacts
```

- `<id>` is the Capability id (unique, kebab-case) and **must equal the folder name**.
- **Migration-staged ownership.** In the initial generator build, `capability.json` *references existing artifact locations by stem* (skills in `commands/gsd/`, agents in `agents/`). The physical move of owned artifacts into `capabilities/<id>/skills|agents|…` is the ADR-857 **phase-6 migration** — out of scope here. The declaration format is identical either way; only the resolver's lookup base changes.
- Genuinely shared artifacts (e.g. `gsd-planner`, used by Plan *and* verify-work) stay in a core/host home and are **referenced, not owned** (ADR-857 decision: "self-contained folder + shared home").

### 2. The `capability.json` schema

A schema-validated JSON data file (ADR-857: hybrid co-located → generated; declarative data, not code). Common envelope plus a role-typed body (`role: feature | runtime`).

**Common envelope (all roles):**

| Field | Type | Notes |
|---|---|---|
| `id` | string (kebab) | unique; equals folder name |
| `role` | `"feature" \| "runtime"` | discriminator |
| `title` | string | human label |
| `description` | string | one-line summary |
| `tier` | `"core" \| "standard" \| "full"` | surfacing tier (maps to install profiles) |
| `requires` | string[] | other capability ids; the registry validates the graph is acyclic |

**`role: "feature"` body:**

| Field | Type | Notes |
|---|---|---|
| `skills` | string[] | owned skill stems (e.g. `"ui-phase"`) — exactly one owner per skill across all capabilities |
| `agents` | string[] | owned agent names (e.g. `"gsd-ui-checker"`) |
| `hooks` | `{event,script}[]` | lifecycle hooks (`SessionStart`/`PostToolUse`/`Stop`/…) |
| `config` | object | **federated config-key schema slice** — `{ "<key>": {type, default, description, …} }`, merged by the config loader (phase 3b) |
| `loopHooks` | LoopHook[] | Loop Extension Point registrations (below) |

**LoopHook** (ADR-857 decisions 4 + 6):

| Field | Type | Notes |
|---|---|---|
| `point` | enum | one of the 12 named points (below) |
| `kind` | `"step" \| "contribution" \| "gate"` | how it participates |
| `ref` | string | the skill / agent / fragment to dispatch at the point |
| `produces` | string[] | artifacts written (e.g. `["UI-SPEC.md"]`) — drives ordering + data flow |
| `consumes` | string[] | artifacts read (e.g. `["CONTEXT.md"]`) |
| `onError` | `"skip" \| "halt"` | default `"skip"` for non-gate (resilient); a hook may opt into `"halt"` |
| `blocking` | boolean | **gates only**; whether a failing gate halts the loop |

The **12 Loop Extension Points** (the stable cross-version contract, ADR-857 → Resolved design details):

```
discuss:pre   discuss:post
plan:pre      plan:post
execute:pre   execute:wave:pre   execute:wave:post   execute:post
verify:pre    verify:post
ship:pre      ship:post
```

**`role: "runtime"` body** (ADR-857 decision 8 — declarative descriptor over a *closed* primitive vocabulary, six axes; no free templates/code):

| Field | Type | Notes |
|---|---|---|
| `runtime.configHome` | string | config dir (e.g. `"~/.claude"`) |
| `runtime.configFormat` | `"settings-json" \| "toml" \| "markdown" \| "markdown-dir" \| "none"` | config-surface primitive |
| `runtime.artifactLayout` | `{ kind, destSubpath, prefix }[]` | per artifact-kind placement |
| `runtime.commandStyle` | enum | command rendering primitive |
| `runtime.hooksSurface` | `"settings-block" \| "hooks-json"` | hook wiring primitive |
| `runtime.sandboxTier` | enum | per-agent sandbox model |
| `runtime.supportTier` | `1 \| 2` | tier-1 (Claude/Codex/Antigravity) fully tested; 2 = shipped, lower-tier |

A runtime descriptor selects named primitives + data only — a novel primitive requires a first-party addition (ADR-857 "declarative + first-party code"). Third-party *loading* stays deferred (ADR-857 decision 8).

### 3. The generator (`scripts/gen-capability-registry.cjs`) — design

Mirrors `gen-inventory-manifest.cjs`:

- **Input:** every `capabilities/*/capability.json`.
- **Validate:** each file against the JSON-schema (§2).
- **Cross-capability invariants** (fail the build on violation):
  - exactly one owner per skill/agent stem (no duplicate ownership);
  - `requires` graph is acyclic and every referenced id exists;
  - every `loopHooks[].point` is one of the 12 valid points;
  - per point, the `produces`/`consumes` graph is acyclic (it drives ordering);
  - `config` keys don't collide across capabilities (federation, phase 3b).
- **Emit:** a generated `capability-registry.cjs` (the registry artifact, §4).
- **Interface:** `--write` (regenerate) and `--check` (drift gate, CI), exactly like the inventory manifest; wired into `npm run build` and a CI drift test.

### 4. The generated registry shape

`capability-registry.cjs` exports a pure, validated, indexed value the install/surface/config/loop adapters consume (ADR-857: install/surface/config/loop are adapters over one declaration):

```js
module.exports = {
  version: '<schema-version>',
  capabilities: { '<id>': { /* validated capability.json, normalized */ }, … },
  bySkill:      { '<skill-stem>': '<capability-id>', … },   // ownership index
  byAgent:      { '<agent-name>': '<capability-id>', … },
  byLoopPoint:  { 'plan:pre': [ { capability:'<id>', hook:{…} }, … ], … },  // ordered per point
  configKeys:   { '<config-key>': '<capability-id>', … },   // federation index
  requiresClosure(id) { /* → transitive requires set */ },
};
```

`byLoopPoint` lists each point's hooks in resolved order (topological sort of `produces`/`consumes`, capability-id tiebreak — ADR-857 decision 6). This is what the phase-3c `loop.render-hooks` query reads and renders.

### Worked example — the UI capability

`capabilities/ui/capability.json`:

```json
{
  "id": "ui",
  "role": "feature",
  "title": "UI design contracts",
  "description": "UI-SPEC design contract + retrospective UI audit for frontend phases.",
  "tier": "standard",
  "requires": ["plan"],
  "skills": ["ui-phase", "ui-review"],
  "agents": ["gsd-ui-checker", "gsd-ui-auditor"],
  "hooks": [],
  "config": {
    "workflow.ui_phase":       { "type": "boolean", "default": true, "description": "Enable the UI design-contract gate during planning." },
    "workflow.ui_review":      { "type": "boolean", "default": true, "description": "Enable the retrospective UI audit." },
    "workflow.ui_safety_gate": { "type": "boolean", "default": true, "description": "Block execution on unmet UI-SPEC contracts." }
  },
  "loopHooks": [
    { "point": "plan:pre", "kind": "step", "ref": "ui-phase",
      "produces": ["UI-SPEC.md"], "consumes": ["CONTEXT.md"], "onError": "skip" },
    { "point": "verify:post", "kind": "step", "ref": "ui-review",
      "produces": ["UI-REVIEW.md"], "consumes": ["UI-SPEC.md"], "onError": "skip" }
  ]
}
```

Maps into the registry as:

```js
capabilities.ui = { …above… }
bySkill   = { 'ui-phase': 'ui', 'ui-review': 'ui' }
byAgent   = { 'gsd-ui-checker': 'ui', 'gsd-ui-auditor': 'ui' }
byLoopPoint['plan:pre']    = [ { capability: 'ui', hook: {ref:'ui-phase', kind:'step', produces:['UI-SPEC.md'], consumes:['CONTEXT.md']} }, … ordered with other plan:pre hooks (research, etc.) by produces/consumes ]
byLoopPoint['verify:post'] = [ { capability: 'ui', hook: {ref:'ui-review', …} } ]
configKeys = { 'workflow.ui_phase':'ui', 'workflow.ui_review':'ui', 'workflow.ui_safety_gate':'ui' }
```

This shows the model carrying all the facets ADR-857 requires — skills, agents, federated config, and two loop hooks at distinct points — for one real feature, declaratively.

## Consequences

**Positive**

- A formal, reviewable `capability.json` contract that 3b (federated config) and 3c (loop seam) build against — no guessing at the format mid-build.
- Resolves ADR-857 Open question #1; the declaration is data (toolchain-free, third-party-authorable), validated by one schema.
- The generator design reuses a proven repo pattern (`gen-inventory-manifest` `--write`/`--check` + drift gate), so the build wiring is well-understood.

**Negative / costs**

- The 12 Loop Extension Point names and the schema become a stability contract — additive-only across versions once capabilities depend on them.
- The cross-capability invariants (single ownership, acyclic `requires`/`produces`) must be enforced by the generator or they rot.
- Migration-staged ownership means a brief window where declarations reference artifacts that physically live elsewhere (until the phase-6 move).

## Alternatives considered

| Decision point | Rejected alternative | Why rejected |
|---|---|---|
| Format | TS module declaration | Off-direction: ADR-857 chose declarative data (toolchain-free, third-party-authorable) |
| Format | Frontmatter in a root skill `.md` | Cramped for federated config schema, loopHooks, and the runtime descriptor |
| Ownership | List artifacts by stem forever (never co-locate) | Weakens the locality ADR-857 exists to deliver; co-location is the phase-6 target |
| Generator | Hand-maintained central registry | Re-creates the registration tax ADR-857 kills; loses single-source-of-truth |
| Scope | Build the generator now | Design-first de-risks the load-bearing format before code depends on it |

## Open questions (for the generator build sub-phase)

- The JSON-schema's exact `$id`/versioning and where the `.schema.json` file lives (`capabilities/capability.schema.json` vs `docs/`).
- Whether `byLoopPoint` ordering is materialized in the generated registry or computed at resolve time by `loop.render-hooks` (3c).
- How `tier` maps onto the existing install profiles (`core`/`standard`/`full`) and `clusters.cjs` during the phase-4 install integration.
- The precise `commandStyle` / `sandboxTier` primitive enums for `role: runtime` (enumerated against the 15 existing runtimes when phase-5 lands).
