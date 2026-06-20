# Install Your First Capability

In this tutorial you will install a third-party GSD capability into a project, grant it consent, confirm it is active, check whether a newer version is available, and remove it again. By the end you will have driven the whole consumer-side lifecycle once, from the command line, with every step working.

This is the *install* side of capabilities. If you want to *author* one, see [Build your first capability](build-your-first-capability.md) — that tutorial builds a capability; this one consumes one.

So that the lesson is self-contained and reproducible offline, you will first create a tiny capability bundle on disk, then install it from a local path exactly as you would install any third-party capability. The capability is called `acme-greet`. It declares a single lifecycle **hook** — an executable surface — so that you see the consent gate fire for real.

---

## Before you begin

You need:

- **GSD 1.6.0 or later** (`gsd --version`). Capability install and management is a 1.6.0 feature, and the capability you build below declares `engines.gsd: ">=1.6.0"`. On an older host the install **hard-blocks** with an `engines` error before anything is staged — it does not partially install. If `gsd --version` reports an earlier version, upgrade GSD before continuing.
- A throwaway working directory. Create one now:

```bash
mkdir ~/cap-consumer-demo && cd ~/cap-consumer-demo
```

You will work inside `~/cap-consumer-demo` for the rest of this tutorial. You do **not** need to run `gsd init` or have an existing settings file — the install in Step 2 creates the host settings file (and its parent directory) for you when you pass `--shared-file`.

---

## Step 1 — Create the capability bundle you will install

A third-party capability is a folder containing a `capability.json` manifest and its declared files. Create one now:

```bash
mkdir -p ./acme-greet/hooks
```

Write the manifest at `./acme-greet/capability.json`:

```json
{
  "id": "acme-greet",
  "role": "feature",
  "version": "1.0.0",
  "title": "Acme Greeter",
  "description": "Prints a greeting on a lifecycle event.",
  "tier": "standard",
  "requires": [],
  "engines": { "gsd": ">=1.6.0" },
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "skills": [],
  "agents": [],
  "config": {},
  "hooks": [
    { "event": "Stop", "script": "hooks/greet.sh" }
  ],
  "steps": [],
  "contributions": [],
  "gates": []
}
```

The `"engines": { "gsd": ">=1.6.0" }` line is the host-compatibility gate: GSD checks it against your running version at install time, and an older host is hard-blocked with an `engines` error (see [Before you begin](#before-you-begin)). Leave it as-is.

Write the hook script it declares at `./acme-greet/hooks/greet.sh`:

```bash
cat > ./acme-greet/hooks/greet.sh << 'EOF'
#!/usr/bin/env bash
echo "Hello from acme-greet"
EOF
chmod +x ./acme-greet/hooks/greet.sh
```

You now have a complete, installable bundle:

```text
~/cap-consumer-demo/
  acme-greet/
    capability.json
    hooks/
      greet.sh
```

Because `acme-greet` declares a `hooks` entry, it has an **executable surface**: installing it would register a script that runs on a lifecycle event. GSD will not activate that without your explicit consent. That is the gate you will see next.

---

## Step 2 — Try to install it, and meet the consent gate

Install from the local path with `--scope project`, so the capability is scoped to this project only. Because the capability declares a runtime hook, also pass `--shared-file .claude/settings.json` — that tells GSD **which** host settings file to splice the hook registration into. (`--shared-file` is relative to the scope root, which for `--scope project` is your project directory. The file does not need to exist yet: when the install actually writes the hook, GSD creates `.claude/settings.json` and its parent directory if absent, and merges the hook into whatever is already there otherwise.) Without it, the bundle would still be staged, but its hook would never be wired into any runtime config — see Step 5:

```bash
gsd capability install ./acme-greet --scope project --shared-file .claude/settings.json
```

The install does **not** complete. You will see a disclosure of the executable surface and a prompt to grant consent, similar to:

```
Error: This capability declares executable surfaces and needs your consent before install:
  This capability ships executable surfaces that will run in your agent runtime:
    hooks (1): run as runtime hook commands
      - Stop -> hooks/greet.sh
Re-run with --yes to grant consent and install.
```

This is intentional and is the heart of the capability trust model: **install never runs capability code**. The bundle is first copied into an isolated staging directory and its manifest is validated — still without executing anything — and then, before the capability is activated, any executable surface it declares is disclosed and must be consented to. Consent gates *activation*: nothing is promoted into place, no ledger entry or consent record is committed, and no host settings file is touched until you grant it. To understand why GSD draws the line here, read [The capability trust model](../explanation/capability-trust-model.md).

---

## Step 3 — Grant consent and install

Re-run the same command with `--yes` to grant consent for the disclosed surface:

```bash
gsd capability install ./acme-greet --scope project --shared-file .claude/settings.json --yes
```

This time the install completes. You will see a confirmation naming the capability, its version, the scope, and the executable surface you consented to:

```json
{
  "status": "installed",
  "id": "acme-greet",
  "version": "1.0.0",
  "scope": "project",
  "disclosure": [
    "This capability ships executable surfaces that will run in your agent runtime:",
    "  hooks (1): run as runtime hook commands",
    "    - Stop -> hooks/greet.sh"
  ]
}
```

Three things happened. The bundle was copied into the project's capability root at `.gsd/capabilities/acme-greet/`; the declared `Stop` hook was spliced into the `--shared-file` you named (`.claude/settings.json`); and — because this is a project-scope install — a **consent record** was written to your user-owned consent store at `${GSD_HOME:-~}/.gsd/consent.json`, bound to this project and this exact bundle. That record, not the in-repo ledger, is what lets the capability activate on this machine. The reasoning behind that split is explained in [The capability trust model](../explanation/capability-trust-model.md#the-project-scope-trust-boundary).

---

## Step 4 — Confirm it loaded

List the capabilities visible to this project:

```bash
gsd capability list
```

`list` emits a JSON array. The first-party capabilities are listed first; your installed overlay `acme-greet` appears as the last entry, with `source: "./acme-greet"`, the `project` scope, and `status: "active"`:

```json
{
  "id": "acme-greet",
  "role": "feature",
  "version": "1.0.0",
  "tier": "standard",
  "source": "./acme-greet",
  "scope": "project",
  "status": "active",
  "reason": null,
  "title": "Acme Greeter"
}
```

`status: "active"` is the signal that the capability is both compatible with your GSD version *and* backed by a consent record on this machine. Had you copied a bundle into `.gsd/capabilities/` by hand — with no consent record — the same row would read `status: "inactive"` with a `reason`, and the capability would contribute nothing.

You can also inspect what you consented to. List your project consent records:

```bash
gsd capability trust list
```

You will see one record for `acme-greet`, keyed by the project root, recording the bundle integrity and disclosure signature you approved:

```json
{
  "id": "acme-greet",
  "scope": "project",
  "projectRoot": "/Users/you/cap-consumer-demo",
  "integrity": "",
  "disclosureSignature": "…",
  "contentHash": "…",
  "consentedAt": "2026-06-20T12:00:00.000Z"
}
```

(The `integrity` field is empty for a local install — a directory has no single hashable artifact — but the `contentHash` still binds the record to the exact bundle content you installed.)

---

## Step 5 — Confirm the hook was registered

Because you installed with `--shared-file .claude/settings.json`, GSD spliced the capability's `Stop` hook into that file at install time. That is the step that actually wires the hook into the runtime — installing the bundle alone does **not** register a hook; only the `--shared-file` splice does. Look at the file:

```bash
cat .claude/settings.json
```

You will see a `hooks.Stop` entry stamped with a `_gsdCapability` marker naming the owning capability, whose `command` is the realpath-confined absolute path to the bundle's own `greet.sh`:

```json
{
  "hooks": {
    "Stop": [
      {
        "_gsdCapability": "acme-greet",
        "hooks": [
          { "type": "command", "command": "'/Users/you/cap-consumer-demo/.gsd/capabilities/acme-greet/hooks/greet.sh'" }
        ]
      }
    ]
  }
}
```

That entry is what makes the `Stop` hook run — printing `Hello from acme-greet` — the next time the runtime fires its `Stop` lifecycle event. The `_gsdCapability` marker is also what lets `remove` strip *exactly* this entry later without touching anything else in `settings.json` (you will see that in Step 7).

Had you installed **without** `--shared-file`, the bundle would still be on disk and `list` would still show it `active`, but `.claude/settings.json` would carry no `Stop` entry — the hook would be declared but never wired in. The `--shared-file` flag is what turns a declared hook into a registered one.

> **`disable`/`enable` do not apply to an installed overlay.** Those verbs validate the id against GSD's **built-in** capability registry, which does not contain capabilities you installed yourself. Running `gsd capability disable acme-greet` fails:
>
> ```text
> capability set: error: unknown capability: "acme-greet"
> Error: capability set: 1 error(s) — see above
> ```
>
> `disable`/`enable`/`set` are for first-party capabilities. The off-switch for an installed overlay like `acme-greet` is `gsd capability remove` — which you will use in Step 7. (For the difference between the two paths, see [Turn a capability off](../how-to/turn-a-capability-off.md).) For now, leave `acme-greet` installed.

---

## Step 6 — Check whether an update is available

Ask GSD whether any installed overlay capability has a newer version available:

```bash
gsd capability outdated
```

This prints a table with one row per installed overlay capability. For a **local** source, `outdated` re-reads the `capability.json` at the recorded path and compares its version with the installed one. The bundle you installed from is still on disk at version `1.0.0`, so the row reports `current` — there is nothing newer to fetch:

```
ID          Source  Current  Latest  Status
----------  ------  -------  ------  -------
acme-greet  local   1.0.0    1.0.0   current
```

For a capability installed from a git URL or npm, `outdated` performs a metadata-only remote peek instead and reports `outdated`, `pinned`, or — when the source cannot be auto-checked — `manual` or `unknown`. It never re-clones or re-extracts a bundle, and a single failing peek never crashes the command. See the [`outdated` reference](../reference/gsd-capability-command.md#outdated) for the full per-source matrix.

---

## Step 7 — Remove it

Remove the capability completely. Because you installed it with `--scope project`, you must remove it from the same scope — `remove` defaults to `global`, so pass `--scope project` here too:

```bash
gsd capability remove acme-greet --scope project
```

(Omitting `--scope` would look in the `global` scope and report `capability "acme-greet" is not installed in global scope`.)

You will see a confirmation listing exactly what was removed:

```json
{
  "status": "removed",
  "id": "acme-greet",
  "scope": "project",
  "removedFiles": [
    ".gsd/capabilities/acme-greet"
  ],
  "strippedEdits": 1,
  "dataPreserved": true
}
```

`strippedEdits` is the **count** of marker-isolated fragments stripped from shared files — `1` here, because removal excised the `Stop` hook entry you saw in `.claude/settings.json` in Step 5. Removal strips **only** entries carrying this capability's `_gsdCapability` marker, so anything else in that file (your own hooks, other settings) is left untouched. `dataPreserved` is `true` because you did not pass `--purge-data` — any runtime data the capability created would be left in place; add `--purge-data` to delete it too.

Removal does three things, leaving no orphaned state: it deletes the bundle from `.gsd/capabilities/` and strips its hook entry from `.claude/settings.json`, removes the ledger entry, and — because this was a project-scope capability — **revokes the consent record** in your consent store. Run `cat .claude/settings.json` and the `acme-greet` `Stop` entry is gone; run `gsd capability trust list` again and the `acme-greet` record is gone; run `gsd capability list` and the `acme-greet` row is gone.

---

## You have installed your first capability

You created a third-party capability bundle, hit the consent gate on an executable surface, granted consent and installed it project-scoped, confirmed it activated by both `list` and `trust list`, checked for updates, and removed it cleanly — consent and all.

The lifecycle you just drove — *disclose, consent, activate, audit, revoke* — is the same one you would use for any capability fetched from a git URL, an npm package, or a tarball. The only difference is where the bundle comes from.

---

## Where next

- [Import a capability from a URL](../how-to/import-a-capability-from-a-url.md) — install a third-party capability from a git URL, tarball, or npm package.
- [Turn a capability off](../how-to/turn-a-capability-off.md) — disable a capability or gate a single one of its hooks.
- [Remove a capability](../how-to/remove-a-capability.md) — the full removal task, including `--purge-data`.
- [The capability trust model](../explanation/capability-trust-model.md) — *why* install never runs code, and how consent and integrity work.
- [How overlay capabilities compose](../explanation/capability-overlay-model.md) — *why* first-party always wins and how precedence is resolved.
- [`gsd capability` command reference](../reference/gsd-capability-command.md) — every subcommand, flag, and output shape.
