# `gsd capability` Command Reference

> **Slash form:** `gsd:capability` (surfaced as a slash command on slash-command runtimes)
> **CLI form:** `gsd capability`
> **Canonical ADR:** [ADR-1244](../adr/1244-capability-ecosystem.md)
> **See also:** [Capability Manifest Reference](capability-manifest.md) · [How to develop a capability](../how-to/develop-a-capability.md) · [The capability trust model](../explanation/capability-trust-model.md)

The `capability` family manages the installation, upgrade, removal, and inspection of GSD capabilities — both first-party (shipped) and third-party overlays. A row for this command also appears in [docs/COMMANDS.md](../COMMANDS.md) (that file is not edited here).

**Implemented in 1.6.0:** `install`, `update`, `remove`, `list`, `disable`, `enable` (plus the pre-existing `state` and `set` introspection/activation subcommands). **Planned (not yet implemented):** `outdated` — see [Planned subcommands](#planned-subcommands).

---

## Subcommands

### `install`

**Synopsis**

```
gsd capability install <spec> [--integrity sha512-<hash>] [--scope global|project] [--yes] [--shared-file <rel>]…
```

**Arguments**

| Argument | Description |
|---|---|
| `<spec>` | Source specification (see [Source specifications](#source-specifications) below). |

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--integrity` | `sha512-<base64>` | — | SHA-512 bundle hash to verify before extraction. When supplied, a mismatch aborts the install. When the source registry or `capability.json` already carries an `integrity` field, both must agree. |
| `--scope` | `global` \| `project` | `global` | Installation root (see [Install layout](#install-layout)). |
| `--yes` | flag | off | Grant consent for the capability's executable surfaces non-interactively. The disclosure is still printed. Without it, an install that declares executable surfaces is **aborted** after printing the disclosure (the CLI is non-interactive — there is no prompt to answer). |
| `--shared-file` | path (repeatable) | — | A file, **relative to the scope root**, into which the capability's disclosed hooks / MCP servers should be spliced (e.g. a runtime's `settings.json`). Each fragment is marker-isolated so `remove` can strip exactly it. When omitted, the bundle still installs (declaratively); no shared-file edits are made. |

**Behaviour**

Resolves `<spec>` to a versioned, staged capability bundle. The pipeline is: fetch → verify integrity or SHA pin → check `engines.gsd` against the installed GSD version → disclose executable surfaces (hooks, command modules, MCP servers) → obtain consent (a declarative capability needs none; an executable one requires `--yes`) → validate the incoming manifest against the trust invariants → extract to the scope root → write the ledger entry atomically.

An overlay whose `id` uses a reserved first-party prefix (`gsd-`, `gsd-core-`, `anthropic-`) is rejected before extraction. Install never executes capability code; staging is copy-only. A declined install (executable surface, no `--yes`) writes **nothing** — no bundle, no ledger entry, no shared-file edits.

A best-effort reconciliation sweep runs before the mutation to recover any crash orphans from a prior interrupted operation.

The ledger file (`<scope-root>/.gsd-capabilities.json`, see [Install layout](#install-layout)) records the installed version, source, integrity hash, owned files, and any fragments written into shared files.

---

### `update`

**Synopsis**

```
gsd capability update [<id> | --all] [--scope global|project] [--yes] [--shared-file <rel>]…
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Capability identifier to update. Omitting both `<id>` and `--all` is an error; passing both is an error. |

**Flags**

| Flag | Description |
|---|---|
| `--all` | Re-resolve and update **every** installed overlay capability in the chosen scope. |
| `--scope` | Scope root to operate in (`global` default; see [Install layout](#install-layout)). |
| `--yes` | Grant consent when the new version's executable set differs from the previously consented one. |
| `--shared-file` | As for `install` — where to splice the (re-derived) hook / MCP fragments. |

**Behaviour**

Re-resolves the capability's **recorded source** (the `source` stored in its ledger entry at install time) and, if the resolved version differs, performs an atomic stage-then-swap: the new bundle is fully staged, verified, and validated before the ledger write commits the swap. A crash during staging leaves the previous version intact; a crash after the ledger write leaves the new version intact, and a reconciliation sweep on the next run resolves any orphaned files.

For third-party capabilities, a version whose executable set (hooks, command modules, MCP servers) differs from the previously consented version requires `--yes` to re-consent before the swap completes; without it the update is aborted and the old version is left fully intact.

`--all` iterates every ledger entry in the scope and reports a per-capability outcome (`upgraded` / `not_installed` / `aborted` / `blocked`). Update availability is source-dependent:

| Source kind | Re-resolution behaviour |
|---|---|
| `<name>@<registry>` | Registry catalogue query |
| git (`https://…/repo.git#<tag>`) | Remote tag fetch |
| npm (`npm:@org/pkg@<range>`) | `npm dist-tags` / range resolution |
| tarball (`https://…/cap-x.y.z.tgz`) | Re-fetch of the recorded URL |
| local (`./local/path`) | Re-read of the recorded filesystem path |

---

### `remove`

**Synopsis**

```
gsd capability remove <id> [--purge-data] [--scope global|project]
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Identifier of the installed overlay capability to remove. |

**Flags**

| Flag | Description |
|---|---|
| `--purge-data` | Also remove data files created by the capability at runtime (artefacts under the capability's declared paths that are not part of the install bundle). |
| `--scope` | Scope root to remove from (`global` default). |

**Behaviour**

Reads the ledger entry for `<id>` and removes exactly: the owned files listed in `files`, and the fragments written into shared files listed in `sharedEdits` (e.g. hook registrations spliced into a `settings.json`). Shared files themselves are not deleted; only the capability's marker-isolated fragments are stripped. The ledger entry is removed atomically after all file operations complete.

First-party capabilities (shipped with GSD) **cannot** be removed via this subcommand — `remove` rejects a first-party `id` and points at the product uninstaller (`gsd --uninstall`).

---

### `disable`

**Synopsis**

```
gsd capability disable <id> [--config-dir <path>] [--runtime <r>] [--scope <s>]
```

**Behaviour**

Marks the capability **inactive** in the runtime activation state — identical to `gsd capability set <id> --off`. A disabled capability stays on disk; it is excluded from the active surface and contributes no hooks, config keys, or loop extension registrations until re-enabled. This toggles the capability-state layer (the runtime config), not the install ledger, so it applies to first-party and overlay capabilities alike. `enable` reverses it without re-fetching.

---

### `enable`

**Synopsis**

```
gsd capability enable <id> [--config-dir <path>] [--runtime <r>] [--scope <s>]
```

**Behaviour**

Clears the inactive flag for `<id>` in the runtime activation state — identical to `gsd capability set <id> --on`. On the next GSD invocation the capability is included in the active surface again, subject to its `engines.gsd` range (an incompatible capability is still skipped with a warning at load time).

---

### `list`

**Synopsis**

```
gsd capability list [--json]
```

**Flags**

| Flag | Description |
|---|---|
| `--json` | Emit the JSON array explicitly. (In 1.6.0 `list` always emits JSON; a formatted table is planned.) |

**Behaviour**

Lists capabilities visible to the current session: first-party capabilities (from the registry) plus installed overlay capabilities in both the `global` and `project` scopes. Emits a JSON array of descriptors.

**Output shape**

```json
[
  {
    "id": "string",
    "role": "feature | runtime | null",
    "version": "semver | null",
    "tier": "core | standard | full | null",
    "source": "first-party | <recorded source string>",
    "scope": "first-party | global | project",
    "status": "active | incompatible",
    "title": "string | null"
  }
]
```

`status` values:

| Value | Meaning |
|---|---|
| `active` | Present and (for overlays) compatible with the running GSD version. |
| `incompatible` | An overlay whose `engines.gsd` range does not satisfy the current GSD version; skipped with a warning at load time. |

> Whether a capability has been turned off via `disable` is reported by `gsd capability state` (the activation-state view), not by `list`.

---

## Planned subcommands

These appear in ADR-1244's command surface but are **not implemented in 1.6.0**. They are documented here so the surface is explicit; invoking them returns the unknown-subcommand error listing the available set.

| Subcommand | Intended behaviour |
|---|---|
| `outdated` | Query each installed overlay's source and report those with a newer version available (`--json` for machine output). Until it ships, `update --all` re-resolves every recorded source and reports what changed. |

---

## Source specifications

The `install` subcommand accepts the following source specification forms.

| Form | Example | Adapter |
|---|---|---|
| Registry name | `my-cap@gsd-registry` | Registry — fetches the capability bundle from the named registry; `integrity` is populated from the registry catalogue. |
| Git URL with tag | `https://github.com/org/repo.git#v1.2.0` | Git — clones/fetches at the specified tag; `#sha:<40-hex>` pins a specific commit. |
| npm package | `npm:@org/gsd-capability-foo@^1.0.0` | npm — resolves via `npm dist-tags` / semver range; installs with `--ignore-scripts`. |
| Tarball URL | `https://host/path/cap-x.y.z.tgz` | Tarball — fetches over HTTPS, verifies SHA-512 when `--integrity` is supplied. |
| Local path | `./local/path` (or an absolute path) | Local — copies from the filesystem path. Auto-update detection is not available for this form. |

Which source forms are *permitted* is governed by the `capabilities.strict_known_registries` policy (see [Configuration](../CONFIGURATION.md) and [the capability trust model](../explanation/capability-trust-model.md)): `null`/absent is permissive, `[]` is lockdown (no third-party sources), and a host allowlist permits only matching registries.

All permitted forms pass through the same pipeline: fetch → verify integrity or SHA pin → check `engines.gsd` → obtain consent → validate → extract → record ledger.

---

## Install layout

Installed overlay capabilities are written under a **scope root** selected by `--scope`:

| Scope | Scope root | Bundle path | Ledger file |
|---|---|---|---|
| `global` | `$GSD_HOME`, defaulting to your home directory | `<root>/.gsd/capabilities/<id>/` | `<root>/.gsd-capabilities.json` |
| `project` | the current project root | `<root>/.gsd/capabilities/<id>/` | `<root>/.gsd-capabilities.json` |

The ledger is the commit point for installs and upgrades. Its entries record the installed version, original source, integrity hash, owned files, and shared-file edits. A reconciliation sweep on the next GSD run resolves crash orphans (files on disk without a ledger entry, or ledger entries with missing files). These paths are exactly the ones the runtime registry overlay reads when composing installed capabilities, so an `install` is visible to the loop without any further step.
