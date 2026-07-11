# Statusline Account / Usage Segment (credential-reading, external API)

GSD's statusline does not read credentials or call external network APIs to
display account-level resource state (5-hour / 7-day rate-limit utilization,
usage windows, plan quotas).

## Why this is out of scope

The statusline draws its data boundary at **local, read-only** sources — see
[`docs/adr/2164-statusline-scope-boundary.md`](../docs/adr/2164-statusline-scope-boundary.md).
It refines the stdin payload Claude Code already sends (model, context meter,
GSD-state) and may add a new *local* source (e.g. `git`), but it does not:

- read Claude Code's OAuth credentials (`.credentials.json`, or the macOS login
  Keychain via `security`), or
- make authenticated network calls (e.g. `https://api.anthropic.com/api/oauth/usage`)
  to fetch data.

Reasons:

- **Trust surface.** A planning-workflow hook reading an OAuth token is a
  materially larger trust surface than any rendering concern — even read-only,
  never-logged, and opt-in. Credential custody belongs to the platform, not to
  a markdown planning tool.
- **Unstable dependency.** The usage endpoint is undocumented; it can change or
  disappear and silently rot the feature.
- **Scope.** Surfacing account/rate-limit state is a platform (Claude Code)
  concern. This matches the prior in
  [`temporal-context.md`](./temporal-context.md): *"Statusline / TUI re-entry is
  platform-level, not GSD-level."*

**Revisit if** a documented, first-party usage API — or a platform-provided
value delivered to the hook without GSD reading credentials — becomes
available. That would move usage display out of the excluded tier.

## Prior requests

- #2164 — "enhancement(statusline): opt-in 5-hour/7-day account usage segment"
