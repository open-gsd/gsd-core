# How to import a capability from a URL

This guide is for GSD users who want to install a published capability — from a git repository, an npm package, a tarball, or a local path. It covers running the install command, understanding the pre-install summary, consenting to executable surfaces, verifying integrity, and choosing a scope.

Before installing a third-party capability, read [Capability trust model](../explanation/capability-trust-model.md) to understand how GSD treats external code.

---

## Run the install command

The `install` subcommand accepts several source spec forms. Use whichever matches how the capability was published.

**Git repository at a tag:**

```bash
gsd capability install https://github.com/some-org/gsd-cap-example.git#v1.0.0
```

**Git repository pinned to a commit SHA (fully reproducible):**

```bash
gsd capability install https://github.com/some-org/gsd-cap-example.git#sha:abc123def456...
```

**npm package:**

```bash
gsd capability install npm:@some-org/gsd-cap-example@1.0.0
```

**Tarball at an HTTPS URL:**

```bash
gsd capability install https://example.com/releases/gsd-cap-example-1.0.0.tgz
```

**Local path (for testing a capability you are developing):**

```bash
gsd capability install ./path/to/capability
```

---

## Read the pre-install summary

Before asking for confirmation, GSD fetches the manifest and displays a summary:

```
Capability:  Example Planning Step
Version:     1.0.0
Author:      Some Org <hello@some-org.example>
Homepage:    https://github.com/some-org/gsd-cap-example
License:     MIT
engines.gsd: >=1.6.0

Artefacts:   3 files (skills: 1, agents: 1, fragments: 1)

Executable surfaces:
  hooks:      plan:pre (step), ship:pre (gate, blocking)
  MCP servers: none
  command modules: none
```

If the capability declares hooks, MCP servers, or command modules, these are listed under **Executable surfaces**. These surfaces run as part of the GSD loop on your machine. Review them carefully.

---

## Consent to executable surfaces

If the capability declares any executable surface — hooks, MCP servers, or command modules — GSD displays a consent prompt:

```
This capability registers executable hooks that will run during your GSD sessions.
Do you consent to installing it? [y/N]
```

If you do not trust the source, type `N` or press Enter to cancel. The capability will not be installed and nothing will be written to disk.

If the capability declares no executable surfaces (skills, agents, and prompt fragments only), GSD installs without a consent prompt.

After initial consent, if you later run `gsd capability update` and the updated version adds new executable surfaces that were not present when you first consented, GSD will prompt for consent again before applying the update.

---

## Verify integrity (recommended for tarballs)

If the capability author has published an `sha512` integrity hash, pass it with `--integrity` to verify the download before extraction:

```bash
gsd capability install https://example.com/releases/gsd-cap-example-1.0.0.tgz \
  --integrity sha512-AbCdEf...
```

If the computed hash does not match the value you provide, GSD aborts the install. Nothing is written to disk. This protects against a tampered or corrupted download.

For Git and npm installs, the hosting platform provides its own transport-layer assurance. The `--integrity` flag is most important for tarball URLs hosted outside a verified registry.

---

## Choose a scope

Use `--scope project` to install the capability for the current project only. The files land in `.gsd/capabilities/<id>/` relative to the project root, and the ledger entry goes into the project's local config.

```bash
gsd capability install <spec> --scope project
```

Use `--scope global` (the default) to install for all your projects on this machine. The files land in `~/.gsd/capabilities/<id>/` and the ledger is written per runtime (for example, `~/.claude/.gsd-capabilities.json`).

```bash
gsd capability install <spec> --scope global
```

Project-scoped capabilities take precedence over global ones when both are present. Use project scope when the capability is specific to one codebase, or when you want to pin a version independently of your global install.

---

## Handle a version mismatch

If the capability's `engines.gsd` requirement is not satisfied by your installed GSD version, the install will be blocked:

```
Error: Capability requires gsd >=1.7.0 but you have 1.6.2.
```

In this case, either upgrade GSD with `gsd update` and retry, or ask the capability author whether an older compatible version is available. If the capability publishes `compatVersions`, GSD may offer to install the newest version compatible with your current GSD:

```
A compatible older version (0.9.0, requires gsd >=1.6.0) is available.
Install that instead? [y/N]
```

---

## Handle a blocked install (strictKnownRegistries)

If your organisation has set `strictKnownRegistries` to a non-empty allowlist in your GSD config, installs from sources outside that allowlist will be refused:

```
Error: Source is not in the known-registries allowlist. Contact your GSD administrator.
```

To install the capability, either ask your administrator to add the source to the allowlist, or install from an approved source.

---

## Skip the confirmation prompt

If you are running in a script or CI context and have already inspected the manifest, pass `--yes` to proceed without interactive prompts. Use this only when you are certain about what you are installing.

```bash
gsd capability install <spec> --yes
```

---

## Confirm the installation

After a successful install, verify the capability is active:

```bash
gsd capability list
```

The output shows each installed capability, its version, scope, and enabled status. If the capability did not activate as expected, check that your GSD version satisfies `engines.gsd` and that the capability is not disabled.

---

## A worked example: projects-sync

[`projects-sync`](https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability) is a reference third-party capability — it mirrors a project's `.planning/ROADMAP.md` to GitHub Issues, Milestones, and Projects v2. Install it the same way as any URL spec:

```bash
gsd capability install https://github.com/The-Artificer-of-Ciphers-LLC/projects-sync-capability.git#v0.1.0 --scope project
gsd-tools config-set projects-sync.enabled true   # opt-in, default off
gsd-tools projects-sync status                     # dry run
```

It is a `role: feature` capability that registers an `execute:pre` step and a `ship:post` contribution (both `onError: skip`) and contributes the `projects-sync` command family — a concrete model for the manifest shape, hook registration, and command-router conventions described in [Develop a capability](./develop-a-capability.md).

---

## Next steps

- [Version and update a capability](./version-a-capability.md) — check for updates with `gsd capability outdated` and apply them with `gsd capability update`.
- [Remove a capability](./remove-a-capability.md) — uninstall with `gsd capability remove`, including the `--purge-data` option.
- [Capability trust model](../explanation/capability-trust-model.md) — the full explanation of how GSD handles trust for first-party and third-party capabilities.
- [Capability manifest](../reference/capability-manifest.md) — field reference for `capability.json`.
