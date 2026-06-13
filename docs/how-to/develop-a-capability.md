# Develop a Capability for GSD 1.5+

This guide shows you how to add or change a first-party GSD Capability after the ADR-857 cutover. In GSD terms, the extension unit is a **Capability**. A plugin is a packaging or host-runtime term, for example a Claude Code plugin or Gemini extension, not the unit that owns a GSD feature.

A Capability is right when the feature can be toggled as one unit and owns its own skills, agents, hooks, config keys, or command family. Keep verifier predicate contracts, the five-step loop spine, and shared infrastructure in core unless the ADRs explicitly move that boundary.

## Start from the boundary

Before writing a manifest, decide whether the work is core or a Capability.

Use a Capability when the feature:

- Can be enabled or disabled without changing the meaning of the base loop.
- Owns a stable feature name such as `research`, `ui`, `graphify`, `ai-integration`, or `pattern-mapper`.
- Adds a step, gate, or contribution at a Loop Extension Point.
- Owns one or more feature config keys.
- Owns a command family that can route through the capability registry.

Keep the work in core when the feature:

- Defines the reliability substrate of the loop, such as the verifier predicate contract described by ADR-550 and ADR-857.
- Is required for every installation profile.
- Mutates shared host workflow state rather than adding a declared hook contribution.

## Create the folder

Create one folder per Capability:

```text
capabilities/<id>/
  capability.json
  fragments/
    plan-pre.md
```

The manifest path is `capabilities/<id>/capability.json`.

The `<id>` must match the `id` field in `capability.json`. Co-locate prompt fragments, owned skills, owned agents, and other owned artefacts under the Capability folder when the schema allows it. Shared host artefacts can be referenced by name, but ownership should remain clear in the manifest.

## Write `capability.json`

Use the existing manifests as the source of truth while the schema is still first-party:

- `capabilities/research/capability.json`
- `capabilities/ai-integration/capability.json`
- `capabilities/pattern-mapper/capability.json`
- `capabilities/ui/capability.json`
- `capabilities/graphify/capability.json`

At minimum, a feature Capability declares:

```json
{
  "id": "example",
  "role": "feature",
  "title": "Example",
  "description": "Adds an example planning step.",
  "tier": "standard",
  "requires": [],
  "skills": [],
  "agents": ["gsd-example-agent"],
  "hooks": [],
  "config": {},
  "steps": [
    {
      "point": "plan:pre",
      "ref": { "agent": "gsd-example-agent" },
      "fragment": { "path": "fragments/plan-pre.md" },
      "produces": ["EXAMPLE.md"],
      "consumes": ["CONTEXT.md"],
      "onError": "skip"
    }
  ],
  "contributions": [],
  "gates": []
}
```

The registry generator validates the shape, ownership, and cross-capability contracts. `ref.skill` must name a skill declared by the same Capability. `ref.agent` must name an agent declared by the same Capability.

## Add hooks

Loop Extension Points are the stable sites where Capabilities attach to the host loop. Phase 6 planning-time features use `plan:pre` so the core planner can ask the registry for active planning hooks instead of reading feature config directly.

Choose the hook kind that matches the behaviour:

- `steps` add a sequenced unit of work, such as running `gsd-phase-researcher` or `gsd-pattern-mapper`.
- `contributions` add labelled context to a host prompt.
- `gates` check a condition and may block when `blocking` is true.

Declare file artefact flow with `produces` and `consumes`. The registry uses those arrays to order hooks and to reject unsatisfied dependencies.

## Use prompt fragments

Use `fragment.path` for prompt text longer than a short sentence:

```json
"fragment": { "path": "fragments/plan-pre.md" }
```

The generator materialises that file into `fragment.inline` in the generated registry. Paths must be relative to the Capability folder, must not be absolute, and must not contain `..`.

Use `fragment.inline` only for short, stable text:

```json
"fragment": { "inline": "Add the generated example context to the planner input." }
```

## Generate and verify the registry

After editing any Capability manifest or fragment, regenerate the committed registry:

```bash
node scripts/gen-capability-registry.cjs --write
```

Then run the drift check:

```bash
node scripts/gen-capability-registry.cjs --check
```

For a planning hook, verify the rendered output:

```bash
node gsd-core/bin/gsd-tools.cjs loop render-hooks plan:pre --raw
```

In installed workflow prose, the same resolver surface appears as `gsd-tools loop render-hooks plan:pre`.

The rendered JSON should include the active hook, the declared `ref`, and the materialised `fragment.inline`.

To verify a runtime-specific surface, pass the same config directory that the runtime installation uses:

```bash
node gsd-core/bin/gsd-tools.cjs loop render-hooks plan:pre --config-dir ~/.claude --raw
node gsd-core/bin/gsd-tools.cjs capability state --config-dir ~/.claude --raw
```

`capability state` is the diagnostic view for the same state that workflow dispatch consumes. For each Capability, `enabled` is true only when the Capability is both installed by the active profile and surfaced by the runtime surface. A hook's `configured` field reflects the `when` config key; `active` is true only when the Capability is enabled and the hook is configured on.

## Own config in the Capability

Declare feature config keys in the Capability manifest:

```json
"config": {
  "workflow.example_enabled": {
    "type": "boolean",
    "default": true,
    "description": "Enable the example planning step."
  }
}
```

Do not add migrated Capability keys to `gsd-core/bin/shared/config-schema.manifest.json`. The central schema remains for host/core keys; Capability-owned keys validate through the generated registry and are merged into `loadConfig` by the federated config overlay. Existing nested `.planning/config.json` values such as `{ "workflow": { "example_enabled": false } }` continue to override the Capability default.

## Wire the workflow through the registry

Host workflows should ask the resolver for active hooks and then dispatch from the resolved data. Do not add new direct `config-get workflow.<feature>` checks to a host workflow for a migrated feature.

The Phase 6 migrations follow this pattern:

- `research` registers a `plan:pre` step that invokes `gsd-phase-researcher`.
- `ai-integration` owns the AI-SPEC planning activation and config key.
- `pattern-mapper` registers a `plan:pre` step that invokes `gsd-pattern-mapper`.
- `plan-phase.md` reads the resolved `PLAN_PRE_HOOKS_JSON` and dispatches `ref.agent` or `ref.skill` from that data.
- `code-review` registers an `execute:post` step and review workflows dispatch from the active hook's `ref.skill`.
- `security` registers a `plan:pre` contribution, a `verify:post` step, and a blocking `ship:pre` gate.
- `nyquist` registers a `verify:post` step for validation coverage auditing.

This keeps "off means off" enforceable by construction: disabled Capabilities are absent from the active hook set, so the host workflow has nothing feature-specific to run.

## Test the Capability

Add focused tests before changing behaviour:

- Registry tests for manifest validation, ordering, config ownership, command family dispatch, or fragment materialisation.
- Workflow text tests for host workflow cutovers when a workflow stops reading direct feature config.
- Behavioural command tests when a command family moves behind `dispatchCapabilityCommand`.
- Documentation tests when the feature changes developer-facing behaviour.

Run the smallest affected tests first, then the full suite before opening a ready PR:

```bash
node --test tests/capability-registry.test.cjs
node --test tests/phase6-planning-capabilities.test.cjs
npm test
```

## Keep the docs with the slice

Every Phase 6 slice that changes capability behaviour must update the relevant docs in the same PR. Use this manual for developer-facing Capability authoring facts, use how-to guides for task flows, and use ADRs only for decisions and trade-offs.
