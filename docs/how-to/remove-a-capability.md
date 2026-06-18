# How to remove or disable a capability

This guide covers two distinct operations: **removing** a capability (deletes its files and cleans up all shared configuration it wrote) and **disabling** a capability (toggles it off without touching any files). Choose the one that fits your intent.

---

## Disable a capability (reversible, files kept)

If you want to stop a capability from participating in the loop but may want it back later, disable it:

```bash
gsd capability disable <id>
```

Disabling is a toggle: no files are deleted, no shared configuration is modified. The capability's hooks stop firing, its skills leave the active surface, and its command modules stop responding. To re-activate it:

```bash
gsd capability enable <id>
```

Everything you had before is restored — hook registrations, config keys, contributed agents — without reinstalling.

If you want to toggle a capability off within a single runtime session rather than system-wide, see [Turn a capability off (and keep it off)](turn-a-capability-off.md).

---

## Remove a capability

Removal is permanent within the current install. Use it when you no longer need the capability and want to reclaim its disk footprint and clean its entries from your runtime configuration.

```bash
gsd capability remove <id>
```

### What is removed

GSD uses the **ledger** — a per-runtime record written at install time (for example, `~/.claude/.gsd-capabilities.json`) — as the authoritative list of what the install owns. Removal acts precisely on that record:

- **Owned files** — every file the capability wrote at install (skills, agents, referenced assets) is deleted.
- **Shared configuration fragments** — entries the capability injected into shared files such as `settings.json` (hooks, MCP server registrations) are stripped. Each capability-added entry is stamped at install with a `_gsdCapability` marker naming the owning capability, and removal strips **only** entries carrying that marker. No other capability's entries — and nothing you added by hand — is touched: if you hand-edited `settings.json` between install and remove (added your own hook, your own MCP server, or any other field), those edits are preserved exactly.
- **Federated config keys** — configuration keys that belong to the capability's declared config slice are dropped from the merged config.

### What is NOT removed

- **Shared files themselves.** Files such as `settings.json` and `hooks.json` are edited in place, not deleted. Only the capability's specific entries are excised.
- **Persistent capability data.** Any data the capability wrote during use (databases, caches, runtime artefacts stored outside the install root) is **not** auto-deleted. You must pass `--purge-data` to remove it, and GSD will prompt for confirmation before doing so:

  ```bash
  gsd capability remove <id> --purge-data
  ```

  If you want to keep your data, omit `--purge-data`. The capability's runtime data will remain on disk even after the capability itself is removed.

### Prompts and confirmation

`gsd capability remove` will ask you to confirm before proceeding. Pass `--yes` to skip the prompt in scripts or non-interactive contexts:

```bash
gsd capability remove <id> --yes
```

If the capability also ships persistent data and you pass `--purge-data`, GSD prompts once more specifically for the data deletion, regardless of `--yes`, because that action is irreversible.

---

## Troubleshooting

**If a previous remove was interrupted** (for example, the process was killed mid-run), GSD's reconciliation sweep repairs the orphaned state automatically on the next command invocation. You do not need to intervene manually; running any `gsd capability` command is sufficient to trigger the sweep.

**If the capability ships hooks**, removal strips its hook entries from `settings.json` without affecting any other hook entry. If after removal you still see the capability's hooks listed under `settings.json`, run:

```bash
gsd capability list --json
```

and confirm the capability is no longer present. If it still appears, re-run the remove command — the reconciliation sweep will complete any partial work.

**If you see "capability not found" during remove**, the capability may have been installed under a different scope (global vs. project). Check which scope it was installed under:

```bash
gsd capability list
```

The `--scope` column indicates whether an entry is `global` or `project`. Pass the matching scope explicitly if needed:

```bash
gsd capability remove <id> --scope global
gsd capability remove <id> --scope project
```

---

## Disable vs. remove: a quick comparison

| | `disable` | `remove` |
|---|---|---|
| Files deleted | No | Yes (ledger-recorded files only) |
| Shared config entries removed | No | Yes (capability's entries only) |
| Federated config keys dropped | No | Yes |
| Persistent data deleted | No | Only with `--purge-data` + prompt |
| Reversible without reinstall | Yes (`enable`) | No |
| Use when | You want it back later | You no longer need it |

---

## Related guides

- [How to version and upgrade a capability](version-a-capability.md)
- [Develop a Capability for GSD 1.5+](develop-a-capability.md)
- [Turn a capability off (and keep it off)](turn-a-capability-off.md)
- [The capability trust model](../explanation/the-capability-trust-model.md) — why removal is surgical and reversible
