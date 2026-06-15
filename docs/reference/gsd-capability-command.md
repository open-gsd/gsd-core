# `gsd capability` Command Reference

> **Slash form:** `gsd:capability` (surfaced as a slash command on slash-command runtimes)
> **CLI form:** `gsd capability`
> **Canonical ADR:** [ADR-1244](../adr/1244-capability-ecosystem.md)
> **See also:** [Capability Manifest Reference](capability-manifest.md) · [How to develop a capability](../how-to/develop-a-capability.md)

The `capability` family manages the installation, upgrade, removal, and inspection of GSD capabilities — both first-party and third-party overlays. A row for this command also appears in [docs/COMMANDS.md](../COMMANDS.md) (that file is not edited here).

---

## Subcommands

### `install`

**Synopsis**

```
gsd capability install <spec> [--integrity sha512-<hash>] [--scope global|project] [--yes]
```

**Arguments**

| Argument | Description |
|---|---|
| `<spec>` | Source specification (see [Source specifications](#source-specifications) below). |

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--integrity` | `sha512-<base64>` | — | SHA-512 bundle hash to verify before extraction. When supplied, a mismatch aborts the install. When the source registry or `capability.json` already carries an `integrity` field, both must agree. |
| `--scope` | `global` \| `project` | `global` | Installation root. `global` writes to `~/.gsd/capabilities/<id>/`; `project` writes to `.gsd/capabilities/<id>/` in the current working directory. |
| `--yes` | flag | off | Suppress the interactive consent prompt. The executable-surface disclosure is still printed; consent is taken as granted. |

**Behaviour**

Resolves `<spec>` to a versioned, staged capability bundle. The pipeline is: fetch → verify integrity or SHA pin → check `engines.gsd` against the installed GSD version → disclose executable surfaces (hooks, command modules) → obtain consent (unless `--yes`) → validate the incoming manifest against conformance invariants over the merged first-party ∪ existing-overlay ∪ new set → extract to the scope root → write the ledger entry atomically.

An overlay whose `id` collides with a first-party capability `id`, or that claims a skill or agent stem already owned, is rejected before extraction. Install never executes capability code; staging is copy-only.

The ledger file (`~/.claude/.gsd-capabilities.json` for the global scope on the Claude runtime, and analogues per runtime) records the installed version, source, integrity hash, owned files, and any fragments written into shared files (e.g. hook registrations in `settings.json`).

---

### `update`

**Synopsis**

```
gsd capability update [<id> | --all]
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Capability identifier to update. Omitting both `<id>` and `--all` is an error. |

**Flags**

| Flag | Description |
|---|---|
| `--all` | Update every installed overlay capability that has a newer version available from its original source. |

**Behaviour**

Fetches the latest version (or the newest version satisfying `engines.gsd`) from the capability's recorded source. Follows the atomic stage-then-swap pattern: the new bundle is fully staged, verified, and validated before the ledger write commits the swap. A crash during staging leaves the previous version intact. A crash after the ledger write leaves the new version intact; a reconciliation sweep on next run resolves any orphaned files.

When `--all` is used, update availability is source-dependent:

| Source kind | Update detection |
|---|---|
| `<name>@<registry>` | Registry catalogue query |
| git (`https://…/repo.git#<tag>`) | Remote tag fetch |
| npm (`npm:@org/pkg@<range>`) | `npm dist-tags` query |
| tarball (`https://…/cap-x.y.z.tgz`) | Not auto-detectable; requires manual `install` with the new URL |
| local (`./local/path`) | Not auto-detectable |

For third-party capabilities, auto-update is **off** by default. When auto-update is enabled, a version whose executable set (hooks, command modules) differs from the previously consented version triggers a re-prompt before the swap completes.

---

### `outdated`

**Synopsis**

```
gsd capability outdated
```

**Flags**

| Flag | Description |
|---|---|
| `--json` | Emit a JSON array instead of the default table. |

**Behaviour**

Queries the source of each installed overlay capability and reports those for which a newer version is available. Capabilities installed from tarball or local-path sources are listed as `"unknown"` for latest version.

**`--json` output shape**

```json
[
  {
    "id": "string",
    "current": "semver",
    "latest": "semver | \"unknown\"",
    "source": "string",
    "scope": "global | project"
  }
]
```

---

### `remove`

**Synopsis**

```
gsd capability remove <id> [--purge-data]
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Identifier of the installed overlay capability to remove. |

**Flags**

| Flag | Description |
|---|---|
| `--purge-data` | Also remove any data files created by the capability at runtime (artefacts under the capability's declared paths that are not part of the install bundle itself). |

**Behaviour**

Reads the ledger entry for `<id>` and removes exactly: the owned files listed in `files`, and the fragments written into shared files listed in `sharedEdits` (e.g. hook registrations spliced into `settings.json`). Shared files are not deleted; only the capability's fragments are stripped. The ledger entry is removed atomically after all file operations complete.

First-party capabilities (shipped with GSD) cannot be removed via this subcommand; the entire product uninstall path (`gsd --uninstall`) handles first-party removal.

---

### `disable`

**Synopsis**

```
gsd capability disable <id>
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Identifier of an installed capability to disable. |

**Behaviour**

Marks the capability as disabled in the ledger. A disabled capability is present on disk but excluded from the runtime overlay; it is skipped by the registry loader and contributes no hooks, config keys, or loop extension registrations. The ledger entry is preserved; `enable` reverses the operation without re-fetching.

---

### `enable`

**Synopsis**

```
gsd capability enable <id>
```

**Arguments**

| Argument | Description |
|---|---|
| `<id>` | Identifier of a previously disabled capability to enable. |

**Behaviour**

Clears the disabled flag in the ledger entry for `<id>`. On the next GSD invocation, the capability is included in the runtime overlay subject to its `engines.gsd` range. If the GSD version has changed since the capability was disabled, the `engines.gsd` check is re-evaluated at load time; an incompatible capability is skipped with a warning.

---

### `list`

**Synopsis**

```
gsd capability list [--json]
```

**Flags**

| Flag | Description |
|---|---|
| `--json` | Emit a JSON array instead of the default table. |

**Behaviour**

Lists all capabilities visible to the current GSD session: first-party capabilities (shipped with GSD) and installed overlay capabilities in both global and project scopes. Disabled capabilities are included with a `disabled` status.

**`--json` output shape**

```json
[
  {
    "id": "string",
    "role": "feature | runtime",
    "version": "semver",
    "tier": "core | standard | full",
    "source": "first-party | string",
    "scope": "first-party | global | project",
    "status": "active | disabled | incompatible",
    "title": "string"
  }
]
```

`status` values:

| Value | Meaning |
|---|---|
| `active` | Loaded and contributing to the current session. |
| `disabled` | Present in the ledger but excluded via `gsd capability disable`. |
| `incompatible` | `engines.gsd` range does not satisfy the current GSD version; skipped with a warning at load time. |

---

## Source specifications

The `install` subcommand accepts the following source specification forms.

| Form | Example | Adapter |
|---|---|---|
| Registry name | `my-cap@gsd-registry` | Registry — fetches the capability bundle from the named registry; `integrity` is populated from the registry catalogue. |
| Git URL with tag | `https://github.com/org/repo.git#v1.2.0` | Git — clones/fetches at the specified tag; `#sha:<40-hex>` pins a specific commit. |
| npm package | `npm:@org/gsd-capability-foo@^1.0.0` | npm — resolves via `npm dist-tags` / semver range; installs with `--ignore-scripts`. |
| Tarball URL | `https://host/path/cap-x.y.z.tgz` | Tarball — fetches over HTTPS, verifies SHA-512 when `--integrity` is supplied. |
| Local path | `./local/path` | Local — copies from the filesystem path relative to the current working directory. Auto-update and `outdated` detection are not available for this form. |

All forms pass through the same pipeline: fetch → verify integrity or SHA pin → check `engines.gsd` → obtain consent → validate → extract → record ledger.

---

## Install layout

Installed overlay capabilities are written to one of two roots, depending on `--scope`:

| Scope | Root path | Ledger file |
|---|---|---|
| `global` | `~/.gsd/capabilities/<id>/` | Per-runtime, e.g. `~/.claude/.gsd-capabilities.json` |
| `project` | `.gsd/capabilities/<id>/` (CWD) | Per-runtime, adjacent to project root |

The ledger is the commit point for installs and upgrades. Its entries record the installed version, original source URL, integrity hash, owned files, and shared-file edits. A reconciliation sweep on the next GSD run resolves crash orphans (files on disk without a ledger entry, or ledger entries with missing files).
