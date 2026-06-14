# Turn a capability off (and keep it off)

This guide shows you how to switch a GSD capability off so it stops taking part in the loop — and stays off — and how to switch off a single feature of a capability without disabling the whole thing.

GSD resolves one capability state from three places: whether the capability is installed, whether it is surfaced, and whether each of its hooks is gated in config. "Off" means off across all three. For why the model works this way, see [Develop a Capability for GSD 1.5+](develop-a-capability.md).

---

## Turn a whole capability off

Use the runtime surface — the on/off switch. It is reversible and needs no reinstall:

```
/gsd:surface disable <capability>
```

For example, to stop the UI capability:

```
/gsd:surface disable ui
```

The capability's skills leave the surface and all of its hooks go inactive. Check the result with:

```bash
node gsd-tools.cjs capability state --raw
```

The capability now reports `enabled: false` and every hook `active: false`. To turn it back on, `/gsd:surface enable ui` — your earlier hook gates are preserved.

---

## Turn off one feature of a capability

To keep a capability on but switch off a single hook, gate that hook instead of disabling the capability. Use `/gsd:settings`, or set the key directly:

```bash
node gsd-tools.cjs capability set code-review --gate workflow.code_review=false
```

The capability stays enabled; only that hook stops firing.

---

## Capabilities that own no skills

Some capabilities (for example, research) contribute only hooks and agents — they have no skills to unsurface, so `/gsd:surface disable` does not affect them. Switch these off by gating their hooks:

```bash
node gsd-tools.cjs capability set research --gate workflow.research=false
```

If you gate every hook of a capability off while it is still surfaced, `gsd-tools capability state` flags it as surfaced-but-inactive — a sign you probably meant to disable the capability itself.

---

## Scripting it

`/gsd:surface` and `/gsd:settings` are the interactive paths. To mutate capability state directly (in scripts or CI), call the underlying command:

```bash
# Disable via surface
node gsd-tools.cjs capability set <id> --off

# Re-enable
node gsd-tools.cjs capability set <id> --on

# Toggle one hook gate
node gsd-tools.cjs capability set <id> --gate <key>=<true|false>
```

See [CLI tools — Capability Commands](../CLI-TOOLS.md#capability-commands) for the full reference.

---

## Related

- [Develop a Capability for GSD 1.5+](develop-a-capability.md)
- [Install a minimal GSD and add skills later](install-minimal-and-add-skills.md)
- [CLI tools reference — Capability Commands](../CLI-TOOLS.md#capability-commands)
- [docs index](../README.md)
