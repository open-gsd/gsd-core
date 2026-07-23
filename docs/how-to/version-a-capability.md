# How to version and upgrade a capability

This guide covers two separate journeys: how a **capability author** keeps their manifest correctly versioned as GSD evolves, and how a **capability consumer** safely applies updates. Read only the section that matches your role; each stands alone.

---

## If you author a capability

### Choose a version number

Every `capability.json` must carry a `version` field expressed as a [semver](https://semver.org) string. GSD rejects a capability manifest that omits it.

Use the standard semver conventions:

| Kind of change | Version bump | Examples |
|---|---|---|
| Backwards-compatible bug fixes or minor prompt improvements | **patch** (0.0.x) | Fix a typo in an agent instruction; tighten a hook condition. |
| New loop-extension hook, new skill, or new config key — existing consumers unaffected | **minor** (0.x.0) | Add a `verify:post` gate; add a new optional config key. |
| Breaking change to the hook contract, removal of a skill or config key, change of `id` | **major** (x.0.0) | Rename a hook extension point; remove a skill consumers depend on. |

Set the version in your manifest before every release:

```jsonc
{
  "id": "my-deploy-gate",
  "version": "1.2.0",
  "engines": { "gsd": ">=1.6.0 <3.0.0" }
}
```

> **First-party capabilities are versioned automatically.** The native capabilities shipped inside GSD (`capabilities/<id>/capability.json`) are stamped in lockstep with the GSD package version at release time by `scripts/sync-manifest-versions.cjs` — their `version` always equals the GSD version, so per-capability semver and `compatVersions` only carry independent signal for **third-party** capabilities. As an author of a third-party capability, you own your own version line; the lockstep rule does not apply to you.

### Decide when to raise `engines.gsd`

The `engines.gsd` range expresses which GSD host versions your capability is compatible with. GSD enforces this as a hard gate at install time and again at load time.

Raise the lower bound when you start using a GSD feature introduced in a specific release — for example, a loop extension point added in 1.7.0, a new manifest field, or a config federation key that does not exist in older GSD builds. Do not raise it pre-emptively; only raise it when the capability genuinely requires the newer behaviour.

When you do raise the lower bound:

1. Bump `version` (at minimum a minor bump, or a major bump if the change is otherwise breaking).
2. Update `engines.gsd` to reflect the new minimum.
3. Add a `compatVersions` entry (see below).

### Maintain `compatVersions`

`compatVersions` is a capability-version → GSD-version-**range** table that lets GSD offer older consumers a downgrade instead of a hard block. Each value is a semver range (the same grammar as `engines.gsd`), evaluated against the running GSD version:

```jsonc
{
  "version": "2.0.0",
  "engines": { "gsd": ">=1.7.0 <3.0.0" },
  "compatVersions": {
    "1.2.0": ">=1.6.0 <1.7.0"
  }
}
```

This entry tells GSD: "version 1.2.0 of this capability is compatible with GSD versions `>=1.6.0 <1.7.0`." When a consumer's GSD is older than the current `engines.gsd` floor (1.7.0), GSD consults `compatVersions`, picks the **newest** capability version whose range the host satisfies, and offers that instead of failing outright.

Add a new entry **only when you change `engines.gsd`** — that is the only moment an older GSD version and a specific capability version become correlated. A `compatVersions` entry is not meaningful for a capability distributed as a bare tarball URL (a tarball exposes a single version and cannot be auto-selected from a table); it is only actionable for sources that enumerate versions: git tags, a registry, or npm.

### Publish a new version

How consumers receive the update depends on your distribution channel.

**Git tag.** Commit the updated `capability.json` (with the new `version` field), then push a tag whose name matches the version:

```bash
git tag v1.2.0
git push origin v1.2.0
```

GSD's git adapter fetches tags to determine what is available. Without a matching tag, the new version is invisible to `gsd capability outdated`.

**npm.** Publish normally. GSD uses `dist-tags` to check for updates, so the standard `npm publish` flow is sufficient:

```bash
npm version 1.2.0
npm publish
```

**New tarball.** Upload the new archive at a URL and communicate the URL to consumers. GSD cannot auto-detect updates for tarball sources, and `gsd capability update` only ever re-resolves the URL **already recorded** in the ledger — it takes no new-URL argument. To move a tarball install to a new URL, the consumer **re-installs from the new URL** (`gsd capability install <new-url> …`), which overwrites the recorded source. If you anticipate frequent updates, consider switching to a git or npm source so `gsd capability update <id>` can pick up new versions automatically.

---

## If you consume a capability

### Check for available updates

Run:

```bash
gsd capability outdated
```

GSD contacts the source of each installed capability and reports which ones have a newer version available. Whether an update is detectable depends on the source:

| Source | Auto-detectable? |
|---|---|
| Git (tags / manifest) | Yes — GSD fetches available tags. |
| npm | Yes — GSD checks `dist-tags`. |
| Tarball URL | **No** — a tarball exposes one version; updates must be applied manually by re-installing from a new URL. |
| Registry (`<name>@<registry>`) | **Not yet** — the registry source kind is reserved but unimplemented today; `outdated` reports `status: unknown` for it and `update` cannot re-resolve it. |

If a capability is installed from a tarball and the author publishes a new version at a different URL, `gsd capability update <id>` will not help — it only re-resolves the URL already recorded at install time, and takes no new-URL argument. Once the author communicates the new address, **re-install from it** with `gsd capability install <new-url> …`; that overwrites the recorded source with the new version.

### Apply an update

To update a specific capability:

```bash
gsd capability update <id>
```

To update all installed capabilities at once:

```bash
gsd capability update --all
```

Updates are **atomic**: GSD fully fetches and validates the new version before swapping it in. The ledger write is the commit point. If GSD stops mid-update (for example, due to a network failure), the next command run will detect the orphaned state via a reconciliation sweep and restore a consistent install — you will never be left with a half-updated capability.

### Consent when the executable surface changes

The CLI is **non-interactive** — it never stops to ask a question. If the new version adds or removes hooks, MCP server entries, or command modules compared to the version you have installed, `gsd capability update <id>` **aborts** rather than swapping: it prints the disclosed surface change and instructs you to re-run with `--yes`, leaving the current version fully in place. Re-running with `--yes` grants consent for the new surface and completes the swap:

```bash
gsd capability update <id> --yes
```

This re-consent is required every time the surface changes, scoped to the declared executable surface of a specific version, so a changed surface is always a fresh `--yes`. (A version whose executable surface is unchanged updates without `--yes`.)

### When `engines.gsd` no longer matches

If the new version of a capability requires a GSD version newer than what you have installed, GSD will tell you clearly and — where the source enumerates versions — offer the newest `compatVersions`-compatible version instead. If no compatible version is available, or the source is a bare tarball, you will need to either upgrade GSD or stay on your current capability version.

---

## Related guides

- [How to remove or disable a capability](remove-a-capability.md)
- [Develop a Capability for GSD 1.5+](develop-a-capability.md)
- [Capability manifest reference](../reference/capability-manifest.md)
- [Turn a capability off (and keep it off)](turn-a-capability-off.md)
