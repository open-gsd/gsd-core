# Statusline draws its data boundary at local, read-only sources

- **Status:** Accepted
- **Date:** 2026-07-11
- **Issue:** #2164
- **Implementation:** Policy ADR — no code change. Governs triage of statusline enhancement/feature requests.

## Decision

The GSD statusline (`hooks/gsd-statusline.js`) may source data from three tiers, and is bounded to the first two:

| Tier | Data source | In scope? |
|------|-------------|-----------|
| 0 — Refine existing | The stdin payload Claude Code already sends (model name, context-window usage, GSD-state read from `.planning/`) | Yes |
| 1 — New local source | Read-only local reads / bounded subprocesses scoped to the workspace (e.g. `git status`) | Yes, if opt-in and bounded |
| 2 — External / credentialed | Reading credentials (OAuth tokens, keychains) or calling external/network APIs for data | No |

The statusline refines what it is already handed and may add a new **local, read-only** source, but it does not read credentials or make authenticated/network calls to fetch data. Surfacing account-level or platform-level resource state (usage limits, rate-limit windows) from a GSD hook is a platform concern, not GSD's.

## Rationale

- The statusline is a planning-workflow surface, not a platform dashboard. Its existing segments (model, context meter, directory, GSD-state) are all local, read-only projections of data GSD is already given.
- Reading credentials from a planning hook is a materially larger trust surface than any rendering concern; even read-only and opt-in, it is not something a planning tool should own.
- External/undocumented endpoints (e.g. an OAuth usage API) are unstable dependencies that rot silently when they change.
- Consistent with the existing prior in `.out-of-scope/temporal-context.md`: *"Statusline / TUI re-entry is platform-level, not GSD-level."*

## Consequences

- New statusline requests are triaged against the tier table. The **data-source** axis (this ADR) is orthogonal to the **enhancement-vs-feature** axis (CONTRIBUTING.md): refining an existing segment is an enhancement; adding a new segment or data source is a feature (a new concept/integration), regardless of tier.
- Applied at decision time:
  - **#2160 / #2161 / #2162** — refine existing model / context-meter / GSD-state rendering. Tier 0; approved as enhancements.
  - **#2163** — git segment. Tier 1 (new local source): in scope, but routed to the feature track (`approved-feature` + complete spec) because it adds a new segment.
  - **#2164** — 5h/7d account-usage segment. Tier 2 (reads OAuth creds + calls `api.anthropic.com/api/oauth/usage`): out of scope; closed `wontfix`, recorded in `.out-of-scope/statusline-account-usage.md`.

## Revisit if

A documented, first-party usage API — or a platform-provided value delivered to the hook without GSD reading credentials — becomes available. That would move usage display out of Tier 2.

## References

- `.out-of-scope/statusline-account-usage.md` — the #2164 rejection record.
- `.out-of-scope/temporal-context.md` — prior "statusline is platform-level" note.
- `CONTRIBUTING.md` — enhancement vs feature gates.
- Issues: #2160, #2161, #2162 (approved enhancements), #2163 (feature-track), #2164 (this ADR's trigger).
