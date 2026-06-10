# ADR-959: Capability Command Contribution

- **Status:** Proposed
- **Issue:** [#959](https://github.com/open-gsd/gsd-core/issues/959)
- **Epic:** [#857](https://github.com/open-gsd/gsd-core/issues/857) (Capability system) — rollout phase 4d
- **Amends:** [ADR-894](894-capability-declaration-format.md) (adds the deferred `commands` field)
- **Realizes:** [ADR-857](857-capability-system.md) decision 7 (in-tree code modules become Capabilities via an opened `runCommand` entrypoint)
- **Builds on:** [ADR-0012](0012-command-routing-hub.md) / [ADR-0174](0174-retire-gsd-sdk-package-boundary.md) (CommandRoutingHub)

## Context

ADR-857 decision 7 reserved a `commands`/`module` field so in-tree code modules (`graphify`, `intel`, `audit`) could "become Capabilities by registering their query family through an **opened `gsd-tools.cjs` entrypoint (registry) over the current hardcoded switch**." ADR-894 fixed the `capability.json` format but **deferred** the `commands` field. This ADR designs it.

The current dispatch reality:

- **`runCommand` is a 73-case hardcoded `switch`** plus 12 `route*Command` family routers (`init`, `config`, `phase`, …). There is no registry table — every command-name → handler binding is hand-written.
- **`_dispatchNonFamily` is a dead shim.** It always returns `false`; its 10 call sites already pass `{ registryCommand, registryArgs, legacyCommand, legacyArgs }` and fall through to the legacy CJS handler. Its own comment says it exists to "keep the helper contract so existing call sites remain unchanged during the phase sequence." It is the deliberately-prepared seam for registry dispatch.
- **The CommandRoutingHub (ADR-0012, simplified by ADR-0174) is stateless.** `createHub({ cjsRegistry, manifest })` is constructed *per dispatch* with an inline `family → subcommand → handler` table and exposes only `{ dispatch }`. There is **no** `register()` API and no persistent family registry. Each of the 12 routers builds a one-shot hub via `routeHubCommandFamily` and discards it. The hub's value is its uniform Result contract (`UnknownCommand`/`InvalidArgs`/`HandlerRefusal`/`HandlerFailure`), manifest-backed subcommand validation, arg-shape coercion, and observability.
- The registry and `capability.json` have **no `commands` field** today (confirmed absent).

Two distinct "command" kinds exist and must not be conflated: **gsd-tools CLI subcommands** (internal, invoked by workflows via `gsd_run`) and **slash-commands/skills** (`commands/gsd/*.md`, agent-facing). This ADR is about the **former** — the CLI subcommand families that code-module features own. Skills are already a capability contribution (`skills`).

## Decision

> **Core principle (grilled):** the codebase already has the right abstraction — the **router**. The 12 `route*Command` functions each own a family's subcommand dispatch + arg parsing, and each already routes through the hub via `routeCjsCommandFamily`. A capability command family is therefore **just a router, discovered via the registry instead of hardcoded** into gsd-tools' requires + switch. The registry's job is *discovery*, not re-implementing routing. This is the minimal change and reuses the proven abstraction wholesale — there is no new handler/arg convention.

### 1. A `commands` contribution on the `feature` role — no new role

A capability declares the CLI command families it owns, alongside its existing `skills`/`agents`/`hooks`/`config` contributions. No new `role` is introduced; a "code-module capability" is simply a `feature` whose primary contribution is `commands` rather than `skills`.

```jsonc
// capability.json (feature role) — new optional field
"commands": [
  {
    "family": "graphify",                  // the top-level gsd-tools command this capability owns
    "module": "graphify.cjs",              // first-party in-tree module under gsd-core/bin/lib/
    "router": "routeGraphifyCommand",      // exported router fn (same shape as the 12 host routers)
    "subcommands": ["query", "status"]     // OPTIONAL — doc/introspection metadata only; NOT used for dispatch
  }
]
```

- **`family`** — the top-level command string (single ownership across all capabilities).
- **`module`** — a first-party path resolved relative to `gsd-core/bin/lib/`. Third-party / out-of-tree modules are **out of scope** (ADR-857 decision 7); they require their own trust/load ADR.
- **`router`** — the exported function with the standard router signature `({ args, cwd, raw, error }) => void` — identical to `routeInitCommand` et al. It owns its own subcommand list, arg parsing, and `defaultSubcommand` internally, exactly as the 12 existing routers do.
- **`subcommands`** — optional, doc/introspection only; dispatch does not consult it (the router owns subcommand resolution).

### 2. The registry materializes a `commandFamilies` index

`gen-capability-registry.cjs` emits a discovery index — `family → {capId, module, router}` — no subcommand/handler enumeration (those live inside the router):

```js
const commandFamilies = {
  "graphify": { capId: "graphify", module: "graphify.cjs", router: "routeGraphifyCommand" }
};
```

Added to `module.exports` alongside `byLoopPoint`, `configKeys`, etc.

### 3. Dispatch = invoke the registry-discovered router (which itself routes through the hub)

The capability's `router` is a standard `route*Command`: internally it calls `routeCjsCommandFamily({ subcommands, handlers, … })` → `routeHubCommandFamily` → the per-call hub — **exactly like the 12 existing routers**. So "route through the hub" is satisfied by reuse, with zero new dispatch machinery and no registry-rebuilt handler table.

The dead `_dispatchNonFamily(...)` shim is replaced by a real `dispatchCapabilityCommand({ command, args, cwd, raw })`:

```text
dispatchCapabilityCommand(command, args, cwd, raw):
  entry = registry.commandFamilies[command]        # guarded literal-key lookup
  if not entry: return false                        # → legacy fall-through (unchanged behavior)
  mod = require('./lib/' + entry.module)            # first-party, confined to bin/lib
  mod[entry.router]({ args, cwd, raw, error })      # the standard router signature
  return true
```

There is **no new handler/arg convention**: the capability author writes a router using the same `routeCjsCommandFamily` helper and the same per-subcommand `parseNamedArgs`/positional access the host routers use. The arg-parsing lives where it always has — inside the router — now owned by the capability.

### 4. Entrypoint placement: the `default` case

The registry dispatch is consulted in the **`default` case** of `runCommand` (unknown command), *before* the unknown-command error:

- An **unmigrated** command still hits its hardcoded `case` arm — untouched, behavior-identical.
- A **migrated** command's `case` arm is *removed* in its cutover PR, so the command now reaches `default` → `dispatchCapabilityCommand` → the capability handler.
- A command owned by no capability and no `case` → `dispatchCapabilityCommand` returns `false` → the existing unknown-command error.

This makes collision **structurally impossible**: a command is dispatched by its hardcoded `case` *or* the registry, never both (a `case` shadows `default`). The 10 existing `_dispatchNonFamily` call sites remain valid no-op seams and become the per-command migration points.

### 5. First-party only; third-party deferred

`module` is confined to `gsd-core/bin/lib/` and `require`d in-process — the same trust level as the host's own handlers. Loading out-of-tree / third-party command modules carries a distinct trust/load/build/security surface and is **deferred to its own ADR** (mirroring the runtime third-party deferral in ADR-857 branch 8). The seam is built so that door can be opened later additively.

### 6. Staged rollout — `graphify` is the first *real* cutover (the pilot), not a synthetic fixture

A synthetic fixture proves the *plumbing* but not the *model*; only a real command exercises router extraction, the full capability bundle (command + skill + config gate + tier), and registry multiplicity. The maintainer also wants a user-testable artifact. So the pilot is a real cutover, chosen for minimum risk:

1. **Build phase (4d-impl):** add the `commands` schema + the `commandFamilies` index + the real `dispatchCapabilityCommand` in the `default` case, **and** cut over **`graphify`** as the first capability that owns a command family — in one cohesive migration:
   - a `graphify` capability bundling its command (`family: graphify`, a new first-party `graphify-command-router.cjs` extracted from the inline `case` sub-switch), its existing skill (`commands/gsd/graphify.md`), its config gate (`isGraphifyEnabled`), and `tier: full`;
   - remove the `case 'graphify':` arm so dispatch flows `default → registry → routeGraphifyCommand`;
   - **equivalence tests** proving every `graphify <sub>` invocation (incl. the `--budget` flag and the hidden `build snapshot`) behaves identically old-path vs new-path.
   - `graphify` is the safest first target: zero workflow hot-path blast radius (no core workflow invokes it via bash — the skill drives it), smallest handler (496 LOC / 4 subcommands), already has a skill + cluster + config gate, and is `full`-only so the 4c install/surface consumption stays a no-op.

   This pilot *is* the phase-6 cutover template, executed once on a low-risk feature to surface integration surprises early.

2. **Per-feature cutover (phase 6):** repeat the graphify template for the remaining code-module features. **`intel` goes last** — a rollout finding: it has no skill and no cluster placement (invoked only from workflow bash), so it is *not* a clean capability and would need its skill/cluster created from scratch.

### Validation invariants (enforced by the generator)

- **Single family ownership** — a `family` is owned by exactly one capability.
- **First-party module** — `module` resolves under `gsd-core/bin/lib/`; no traversal.
- **Router presence** — `router` is a non-empty string; its existence as an export is verified at load (and may be lint-checked).
- **Prototype-pollution guards** at every dynamic-key site (the repo's CodeQL barrier), as with the other registry indexes.

**Shadowing is *not* a generator concern (grilled).** Because dispatch sits in the `default` case, a capability that names a still-live hardcoded command is *harmless at runtime* — the hardcoded `case` always wins and the capability command simply never dispatches. So no upfront `HOST_RESERVED_COMMANDS` list is maintained (it would be a real new maintenance surface for a problem the placement already neutralizes). The one moment it bites is a phase-6 cutover that adds the capability command but forgets to remove the old `case` (silent no-op). That is caught by a **one-line cutover test** ("command X now dispatches to capability Y"), not a build-time gate.

## Alternatives considered

1. **Registry rebuilds the hub handler table (`subcommands:[{name,export}]` → per-call hub).** Rejected after grilling: this re-implements, in the registry + dispatcher, what a `route*Command` already does (subcommand list, handler wiring, arg parsing, `defaultSubcommand`). Discovering a *standard router* instead keeps the existing abstraction intact, removes the need for the registry to know subcommands/exports, and dissolves any "new handler/arg convention." The chosen design routes through the hub *because the discovered router does* (via `routeCjsCommandFamily`) — satisfying the hub decision with zero new dispatch machinery.
2. **Direct `byCommand → module.export` dispatch (bypass the hub entirely).** Rejected (maintainer choice): the discovered-router path already routes through the hub (ADR-0174's uniform Result/manifest/observability) and stays consistent with the 12 family routers.
3. **A new persistent hub registry (`hub.register(family, handlers)`).** Rejected: the hub is intentionally stateless (ADR-0012/0174); introducing a singleton mutable registry contradicts that design and is unnecessary — a registry-discovered router constructs its own per-call hub exactly as today.
4. **A generator `HOST_RESERVED_COMMANDS` shadowing gate.** Rejected after grilling: the `default`-case placement makes shadowing harmless at runtime, so an upfront host-reserved list is a maintenance surface for a neutralized problem. A one-line cutover test covers the only failure mode (forgetting to remove a migrated `case`).
5. **A new `role: code-module`/`tool`.** Rejected: commands are just another contribution kind on a `feature`; a separate role adds taxonomy without behavior.
6. **Migrate the 73 hardcoded cases now.** Rejected: that is the per-feature cutover (phase 6). Build the mechanism + a synthetic pilot first (registry-only), proven behavior-preserving — the rollout's consistent pattern.
7. **Open the entrypoint at each `_dispatchNonFamily` call site (not `default`).** Rejected as the *primary* placement: the `default`-case approach makes collision structurally impossible and keeps unmigrated commands on their exact current path. The per-case shims remain as migration markers.

## Consequences

- **Positive:** code-module features can own CLI command families declaratively; the hardcoded switch shrinks one command at a time at cutover; dispatch reuses the audited hub contract; the third-party door is left openable additively; the `graphify` pilot is a tangible, testable plug-in *and* the proven phase-6 template.
- **Negative / cost:** a second dispatch path (registry `default`-case) coexists with the 73-case switch until migrations complete; a capability command family is a first-party router the author must write to the existing `route*Command` shape (no new convention, but it is real code the registry only *discovers*); the pilot is a real migration, so `graphify`'s dispatch path changes (equivalence-proven) rather than being a pure no-op.
- **Neutral:** every *non*-migrated command stays on its exact current `case` path; the registry-`default` seam is dormant for them.

## Out of scope

The build (4d-impl); migrating commands other than the `graphify` pilot; third-party / out-of-tree command modules; phase 5 (runtime descriptors); the remaining phase-6 per-feature cutovers.
