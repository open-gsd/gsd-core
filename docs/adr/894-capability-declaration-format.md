# ADR-894: Capability declaration format + registry generation [Proposed]

- **Status:** Proposed
- **Date:** 2026-06-08 (amended same day after a design grilling — see "Grilling amendments")
- **Issue:** #894
- **Parent:** ADR-857 (Capability system) — resolves its Open question #1
- **Phase:** ADR-857 rollout phase 3a (design-only)

## Context

[ADR-857](857-capability-system.md) decided the **Capability** model: the five-step loop is the privileged host; every other feature is a Capability declared co-located and compiled into a generated central **Capability Registry**, owning its skills, agents, hooks, federated config-key schema, and **Loop Extension Point** registrations. ADR-857 deferred one detail to phase 3:

> *"The exact on-disk shape of a co-located Capability declaration (folder layout, declaration format)."*

The generator, the federated config loader (phase 3b), and the loop seam (phase 3c) all build against that format. This ADR fixes it **as a reviewable design** with no code. It reuses the repo's proven co-located-source → generated-central pattern with a `--write`/`--check` drift gate (`scripts/gen-inventory-manifest.cjs`, `scripts/research-profiles.cjs`).

## Decision

### 1. Folder layout

```
capabilities/
  <id>/
    capability.json          # the declaration (this ADR's subject)
    # (future) skills/ agents/ hooks/ loop/    — co-located owned artifacts
```

- `<id>` is the Capability id (unique, kebab-case) and **must equal the folder name**.
- **Migration-staged ownership.** The initial generator references existing artifact locations by stem (skills in `commands/gsd/`, agents in `agents/`); the physical move into `capabilities/<id>/…` is the ADR-857 **phase-6 migration**. The declaration format is identical either way.
- Genuinely shared artifacts (e.g. `gsd-planner`) stay in a core/host home and are **referenced, not owned**.

### 2. The `capability.json` schema

Schema-validated JSON. A common envelope plus a **role-typed body** (`role: feature | runtime`).

**Common envelope (all roles):**

| Field | Type | Notes |
|---|---|---|
| `id` | string (kebab) | unique; equals folder name |
| `role` | `"feature" \| "runtime"` | discriminator |
| `title`, `description` | string | human label + one-line summary |
| `tier` | `"core" \| "standard" \| "full"` | surfacing tier (maps to install profiles) |
| `requires` | string[] | **other Capability ids only** — never host steps (the host loop is always present). Generator enforces: every id exists, graph is acyclic, and edges are **tier-monotone** (a `core` capability may not require a `standard`/`full` one; `standard` may not require `full`). |

**`role: "feature"` body** — note the **three typed hook arrays** (one per ADR-857 hook kind), not a single `loopHooks[]`:

| Field | Type | Notes |
|---|---|---|
| `skills` | string[] | owned skill stems — exactly one owner per stem across all capabilities |
| `agents` | string[] | owned agent names |
| `hooks` | `{event, script}[]` | lifecycle hooks (`SessionStart`/`PostToolUse`/`Stop`/…) |
| `config` | object | federated config-key schema slice `{ "<key>": {type, default, description} }` |
| `steps` | Step[] | sequence hooks (run as their own unit) |
| `contributions` | Contribution[] | inject markdown into a core step's agent prompt |
| `gates` | Gate[] | check-and-maybe-block hooks |

```jsonc
// Step — runs at a point as its own unit; order derives from produces/consumes
{ "point": "plan:pre", "ref": { "skill": "ui-phase" },   // ref is {skill:…} | {agent:…}
  "produces": ["UI-SPEC.md"], "consumes": ["CONTEXT.md"],
  "onError": "skip" }                                      // "skip" (default) | "halt"

// Contribution — injects a fragment into a NAMED agent role's prompt
{ "point": "plan:pre", "into": "planner",                 // into ∈ the step's published agentRoles
  "fragment": { "path": "loop/threat-model.md" },          // {path:…} | {inline:"…"}
  "onError": "skip" }
// Contributions carry NO produces/consumes. Multiple contributions into the same
// agent render as ordered labeled blocks (<contribution from="<id>">…), ordered by
// capability-id (ADR-857 decision 6). The host controls the active set, so a stable
// arbitrary order is acceptable.

// Gate — checks and optionally blocks
{ "point": "execute:wave:post", "check": { "query": "ui.safety-gate" }, // {query:…} | {agentVerdict:…}
  "blocking": true, "onError": "halt" }
// A query gate is deterministic (a gsd_run query). An agentVerdict gate is an LLM
// check — RECOMMENDED advisory (blocking:false) unless its verdict is deterministic.
```

**`role: "runtime"` body** (ADR-857 decision 8 — declarative descriptor over a *closed* primitive vocabulary; no skills/steps/contributions/gates):

| Field | Notes |
|---|---|
| `runtime.configHome` | config dir (`"~/.claude"`) |
| `runtime.configFormat` | `"settings-json" \| "toml" \| "markdown" \| "markdown-dir" \| "none"` |
| `runtime.artifactLayout` | `{kind, destSubpath, prefix}[]` |
| `runtime.commandStyle`, `runtime.hooksSurface`, `runtime.sandboxTier` | closed enums |
| `runtime.supportTier` | `1` (Claude/Codex/Antigravity, fully tested) \| `2` (shipped, lower-tier) |

### 3. The Loop Host Contract (host-side companion)

Capability hooks attach to the host, so the host must **publish what it exposes** — otherwise `into: "planner"`, `consumes: ["RESEARCH.md"]`, and `point: "plan:pre"` are unverifiable strings. gsd-core ships a host contract for the five steps; the generator validates every hook against it.

```jsonc
// loop-host-contract (one entry per step)
{ "step": "plan",
  "points": ["plan:pre", "plan:post"],
  "agentRoles": ["researcher", "planner", "checker"],   // targetable by contribution.into
  "coreArtifacts": { "produces": ["PLAN.md"], "consumes": ["CONTEXT.md"] } }
```

The 12 points, and (illustrative) per-step agent roles:

| Step | Points | Agent roles |
|---|---|---|
| discuss | `discuss:pre` `discuss:post` | (orchestrator) |
| plan | `plan:pre` `plan:post` | `researcher` `planner` `checker` |
| execute | `execute:pre` `execute:wave:pre` `execute:wave:post` `execute:post` | `executor` `verifier` |
| verify | `verify:pre` `verify:post` | (orchestrator) |
| ship | `ship:pre` `ship:post` | (orchestrator) |

**Generator validation against the contract:** every hook `point` ∈ host points; every `contribution.into` ∈ that step's `agentRoles`; every `step.consumes` is satisfiable by the step's `coreArtifacts.produces` or by an earlier hook's `produces` at/before that point (acyclic); `step.produces` names are well-formed artifacts.

### 4. The generator (`scripts/gen-capability-registry.cjs`) — design

Mirrors `gen-inventory-manifest.cjs` (`--write` / `--check` drift gate, build-wired, CI test). Inputs: every `capabilities/*/capability.json`. Validate each against the JSON-schema (§2), then enforce cross-capability invariants (fail the build on violation):

- exactly one owner per skill/agent stem;
- `requires`: ids exist, acyclic, **tier-monotone**;
- every hook `point` valid, every `contribution.into` valid, `produces`/`consumes` resolvable (§3);
- **config-key ownership is exclusive AND complete**: a federated key must be owned by exactly one capability **and absent from the central `config-schema`** — a key present in both is a collision (it means a migration is mid-flight; finish the move).

Emit the registry (§5).

### 5. The generated registry shape

One `capability-registry.cjs`, **role-partitioned indexes** (feature indexes cover only `role:feature`; the `runtimes` index covers only `role:runtime`):

```js
module.exports = {
  version: '<schema-version>',
  capabilities: { '<id>': { /* validated, normalized */ }, … },   // all roles, by id
  // ── feature-role indexes ──
  bySkill:     { '<skill-stem>': '<id>', … },
  byAgent:     { '<agent-name>': '<id>', … },
  byLoopPoint: { 'plan:pre': { steps:[…ordered…], contributions:[…], gates:[…] }, … },
  configKeys:  { '<config-key>': '<id>', … },
  // ── runtime-role index ──
  runtimes:    { '<id>': { /* descriptor */ }, … },
  requiresClosure(id) { /* → transitive requires set */ },
};
```

`byLoopPoint[point]` is partitioned by kind: `steps` ordered by the `produces`/`consumes` topological sort (capability-id tiebreak); `contributions` grouped by `into`, ordered by capability-id; `gates` as declared. This is what the phase-3c `loop.render-hooks` query reads.

### Worked example — the UI capability

`capabilities/ui/capability.json` (split-array shape; `requires` empty — Plan is the host, not a dependency):

```json
{
  "id": "ui",
  "role": "feature",
  "title": "UI design contracts",
  "description": "UI-SPEC design contract + retrospective UI audit for frontend phases.",
  "tier": "standard",
  "requires": [],
  "skills": ["ui-phase", "ui-review"],
  "agents": ["gsd-ui-checker", "gsd-ui-auditor"],
  "hooks": [],
  "config": {
    "workflow.ui_phase":       { "type": "boolean", "default": true, "description": "Enable the UI design-contract gate during planning." },
    "workflow.ui_review":      { "type": "boolean", "default": true, "description": "Enable the retrospective UI audit." },
    "workflow.ui_safety_gate": { "type": "boolean", "default": true, "description": "Block execution on unmet UI-SPEC contracts." }
  },
  "steps": [
    { "point": "plan:pre",    "ref": { "skill": "ui-phase" },  "produces": ["UI-SPEC.md"],   "consumes": ["CONTEXT.md"], "onError": "skip" },
    { "point": "verify:post", "ref": { "skill": "ui-review" }, "produces": ["UI-REVIEW.md"], "consumes": ["UI-SPEC.md"], "onError": "skip" }
  ],
  "contributions": [],
  "gates": [
    { "point": "execute:wave:post", "check": { "query": "ui.safety-gate" }, "blocking": true, "onError": "halt" }
  ]
}
```

(For contrast, a `contribution` looks like the security capability's: `{ "point": "plan:pre", "into": "planner", "fragment": { "path": "loop/threat-model.md" }, "onError": "skip" }` — injected into the planner's prompt, no artifact produced.)

Registry projection:

```js
capabilities.ui = { …above… }
bySkill   = { 'ui-phase': 'ui', 'ui-review': 'ui' }
byAgent   = { 'gsd-ui-checker': 'ui', 'gsd-ui-auditor': 'ui' }
byLoopPoint['plan:pre']         = { steps: [ {capability:'ui', ref:{skill:'ui-phase'}, produces:['UI-SPEC.md'], consumes:['CONTEXT.md']}, …research etc. ordered by produces/consumes ], contributions: [ /* security → planner, … */ ], gates: [] }
byLoopPoint['verify:post']      = { steps: [ {capability:'ui', ref:{skill:'ui-review'}, …} ], contributions: [], gates: [] }
byLoopPoint['execute:wave:post']= { steps: [], contributions: [], gates: [ {capability:'ui', check:{query:'ui.safety-gate'}, blocking:true} ] }
configKeys = { 'workflow.ui_phase':'ui', 'workflow.ui_review':'ui', 'workflow.ui_safety_gate':'ui' }
```

## Grilling amendments

This ADR was stress-tested before merge; the format changed materially as a result:

1. **`loopHooks[]` → three typed arrays** (`steps`/`contributions`/`gates`). A single `ref` string only fit `step`; `contribution` (inject a fragment) and `gate` (run a check) need different shapes.
2. **`contribution.into: <agent-role>`** — resolves "inject into the step" when a step has multiple agents; contributions drop `produces`/`consumes` and order by labeled-block + capability-id.
3. **Loop Host Contract added (§3)** — hooks validate against a *published* host contract (points + agent roles + core artifacts), not trusted strings.
4. **`requires` = capabilities only** — host steps are implicit; `requires:["plan"]` removed. Added the **tier-monotone** invariant.
5. **Config federation = atomic move** — a migrated key leaves the central schema in the same PR; presence in both is a collision (the invariant is correct).
6. **One registry, role-partitioned indexes** — feature indexes vs a `runtimes` index in one artifact.

## Consequences

**Positive**

- A formal, *enforceable* contract: every hook is validated against the host contract at generation, not merely well-formed. The format moved from "looks right" to "the generator can check it."
- Resolves ADR-857 Open question #1; reuses the proven `gen-*` `--write`/`--check` pattern.
- Role-partitioned indexes keep feature vs runtime consumers from misusing each other's data.

**Negative / costs**

- The 12 points, the agent-role vocabularies, and the schema are a stability contract — additive-only once capabilities depend on them.
- A new host-side artifact (the Loop Host Contract) must be authored and kept in sync with the actual step workflows.
- Config-key migration is atomic-per-feature — a partially-migrated key fails the gate by design.

## Alternatives considered

| Decision | Rejected | Why |
|---|---|---|
| Hook shape | one `loopHooks[]` with polymorphic `ref` / string-ref-by-convention | typed arrays let the generator + resolver branch on a known shape; convention is implicit and unenforceable |
| Contribution target | "inject into the step" | ambiguous for multi-agent steps; `into: <agent-role>` is precise |
| `requires` | capabilities + host steps / `requires`+`loopAffinity` | host is always present (trivially satisfied); capability-only keeps the graph meaningful |
| Registry | two registries / one flat map | role-partitioned indexes in one artifact: single generator, role-correct surfaces |
| Config | both-allowed-if-identical / central-authoritative-until-cutover | atomic move keeps one source of truth; drift/dual-definition rejected |
| Format | TS module / skill frontmatter | declarative data is toolchain-free + third-party-authorable (ADR-857) |

## Open questions (for the generator-build sub-phase)

- JSON-schema `$id`/versioning and where `capability.schema.json` and the Loop Host Contract file live.
- Whether `byLoopPoint` ordering is materialized in the registry or computed at resolve time by `loop.render-hooks` (3c).
- How `tier` maps onto the existing install profiles (`core`/`standard`/`full`) and `clusters.cjs` (phase-4 install integration), and how the registry vs `clusters.cjs` dual-source-of-truth is reconciled during migration.
- The exact `commandStyle`/`sandboxTier`/`hooksSurface` enums for `role: runtime` (enumerated against the 15 runtimes in phase 5).
- Whether `agentVerdict` gates are permitted to be `blocking` at all, given LLM non-determinism (lean: advisory-only).
