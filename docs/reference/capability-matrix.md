# Capability matrix reference

> **Generated file — do not edit by hand.**
> This matrix is generated from the capability registry by
> `scripts/gen-capability-matrix.cjs` (introduced in 1.6.0) and kept honest
> by a drift guard in CI. Any manual edit will be overwritten on the next
> generation run. To change a capability's declared metadata, edit the
> corresponding `capabilities/<id>/capability.json` and rebuild.

See also: [ADR-1244](../adr/1244-capability-ecosystem.md) —
[Capability manifest fields](#manifest-field-reference) —
[Trust model explanation](../explanation/capability-trust-model.md)

---

## Column definitions

| Column | Description |
|---|---|
| **id** | Canonical capability identifier; must be unique across first- and third-party capabilities. Reserved prefixes: `gsd-`, `gsd-core-`, `anthropic-`. |
| **role** | `feature` — extends what the loop does; `runtime` — adapts GSD to a specific AI runtime/IDE. |
| **tier** | `core` — always active; `standard` — active when the runtime supports it; `full` — opt-in or runtime-specific. |
| **version** | Semver version of the capability. Values shown are placeholders; the generator stamps exact per-capability versions from `capability.json` at release. |
| **engines.gsd** | Semver range expressing host-version compatibility. A hard gate at install and at load. |
| **extension points** | Loop extension points this capability registers into. See [the phase loop](../explanation/the-phase-loop.md) for the full ordered list. `see capability.json` means the generator would emit the precise set; only well-known registrations are listed here. |
| **hook kinds** | Subset of `step`, `contribution`, `gate` that the capability's hooks use. |
| **source** | `first-party` — ships with GSD Core; `third-party` — installed from an external source via `gsd capability install`. |

---

## Native (first-party) capabilities

First-party capabilities are implicitly trusted: they ship as part of the GSD
Core package and are stamped with the package version at release (per
ADR-1244 D6). They are not subject to the consent or integrity-pin flow
applied to third-party capabilities.

### Feature capabilities (role: feature)

Feature capabilities extend what the five-step loop does — contributing
research, planning, execution, verification, or ship artefacts.

| id | role | tier | version | engines.gsd | extension points | hook kinds | source |
|---|---|---|---|---|---|---|---|
| `research` | feature | standard | 1.6.0 | `>=1.6.0` | `discuss:pre`, `plan:pre` | step, contribution | first-party |
| `ui` | feature | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `ai-integration` | feature | standard | 1.6.0 | `>=1.6.0` | see capability.json | step, gate | first-party |
| `security` | feature | full | 1.6.0 | `>=1.6.0` | `execute:pre`, `verify:pre` | gate | first-party |
| `code-review` | feature | standard | 1.6.0 | `>=1.6.0` | `verify:pre`, `verify:post` | step, gate | first-party |
| `schema-gate` | feature | standard | 1.6.0 | `>=1.6.0` | `execute:pre` | gate | first-party |
| `pattern-mapper` | feature | standard | 1.6.0 | `>=1.6.0` | see capability.json | contribution | first-party |
| `nyquist` | feature | full | 1.6.0 | `>=1.6.0` | see capability.json | step, gate | first-party |
| `validation` | feature | standard | 1.6.0 | `>=1.6.0` | `verify:pre`, `verify:post` | step, gate | first-party |
| `graphify` | feature | full | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `intel` | feature | standard | 1.6.0 | `>=1.6.0` | see capability.json | step, contribution | first-party |
| `audit` | feature | standard | 1.6.0 | `>=1.6.0` | see capability.json | step, gate | first-party |

> **Note:** version `1.6.0` is the placeholder the generator replaces with the
> actual per-capability `version` field from each `capability.json`. The 12
> loop extension points available to feature capabilities are, in order:
> `discuss:pre`, `discuss:post`, `plan:pre`, `plan:post`, `execute:pre`,
> `execute:wave:pre`, `execute:wave:post`, `execute:post`, `verify:pre`,
> `verify:post`, `ship:pre`, `ship:post`. A capability registers into the
> subset it needs; registration of all 12 is unusual.

### Runtime capabilities (role: runtime)

Runtime capabilities adapt GSD to a specific AI runtime or IDE — emitting
skills, agents, hooks configuration, and surface files appropriate for that
host environment.

| id | role | tier | version | engines.gsd | extension points | hook kinds | source |
|---|---|---|---|---|---|---|---|
| `claude` | runtime | core | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `codex` | runtime | core | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `gemini` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `antigravity` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `cline` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `cursor` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `opencode` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `kilo` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `copilot` | runtime | full | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `augment` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `trae` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |
| `qwen` | runtime | standard | 1.6.0 | `>=1.6.0` | see capability.json | step | first-party |

> **Note:** runtime capabilities typically do not register into the 12 loop
> extension points in the same way feature capabilities do — their primary
> responsibility is surface emission (skills, agents, config). Exact hook
> registrations, where they exist, are emitted by the generator into the
> `extension points` cell.

---

## Third-party capabilities

Once a user installs a third-party capability via `gsd capability install
<spec>`, it enters the **runtime registry overlay** (ADR-1244 D2) and appears
in this matrix on their machine alongside native capabilities. Third-party
rows use the same column schema as first-party rows.

### How a third-party row is produced

The generator reads the capability's `capability.json` from the per-scope
install root (`~/.gsd/capabilities/<id>/` for global installs;
`.gsd/capabilities/<id>/` for project-scoped installs), validates it against
the same conformance rules applied to native manifests, and emits a row
identical in shape to the native rows above. The only difference is the
`source` column, which shows `third-party`.

### Column values for third-party rows

| Column | Value |
|---|---|
| **id** | As declared in `capability.json`. Must not use reserved prefixes (`gsd-`, `gsd-core-`, `anthropic-`). |
| **role** | `feature` or `runtime`, as declared. |
| **tier** | `core`, `standard`, or `full`, as declared. |
| **version** | Semver from `capability.json`; the value recorded in the ledger at install time. |
| **engines.gsd** | Range from `capability.json`; verified at install and at each load. |
| **extension points** | As declared in `capability.json`. Validated against the known 12 extension-point identifiers. |
| **hook kinds** | `step`, `contribution`, and/or `gate` as declared. Disclosed in the consent summary at install. |
| **source** | `third-party` |

### Community registry

Whether GSD operates or advertises a central community registry of third-party
capabilities is **TBD/TBA** (see [PRD-1244 §8](../prd/1244-capability-ecosystem.md#8-open-questions--decisions-deferred)).
The matrix mechanic and all manifest fields ship in 1.6.0 regardless of that
decision. URL/git/npm/tarball import does not depend on a central registry.

---

## Manifest field reference

The fields below are defined in `capability.json` and govern how a capability
appears in this matrix. For the full schema, see [ADR-1244 D1](../adr/1244-capability-ecosystem.md#d1--versioned-capability-manifest).

| Field | Required | Type | Purpose |
|---|---|---|---|
| `version` | **Yes** | semver string | Capability version. The registry rejects manifests without this field. |
| `engines.gsd` | Recommended | semver range | Host-version compatibility gate. Enforced at install and load. |
| `compatVersions` | No | object: cap-version → min-gsd-version | Graceful downgrade table for sources that enumerate versions (git tags, registry, npm). |
| `integrity` | No | `sha512-<base64>` | SHA-512 digest of the capability bundle. Verified before extraction when present; mismatch aborts. |
| `provenance` | No | `{ sourceRepo, commit }` | Source provenance. SHOULD be present for first-party and curated capabilities; populated in CI. |

---

## Related documents

- [ADR-1244 — Capability Ecosystem](../adr/1244-capability-ecosystem.md)
- [Capability trust model](../explanation/capability-trust-model.md) — why the trust rules are structured the way they are
- [The phase loop](../explanation/the-phase-loop.md) — the 12 loop extension points in context
- [ADR-857](../adr/857-capability-system.md) — the original capability architecture; D7 and D8 extended by ADR-1244
- [ADR-894](../adr/894-capability-declaration-format.md) — capability declaration format
- [ADR-1016](../adr/1016-runtime-capability-descriptor.md) — runtime capability descriptor
