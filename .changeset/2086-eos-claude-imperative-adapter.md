---
type: Changed
pr: 2106
---
**Internal: Claude Code's installer is now driven through the public Host-Integration Interface (ADR-1239 / EoS).** `bin/install.js` routes `claude` install/uninstall through the imperative adapter (`createImperativeAdapter`) instead of calling the engine directly, and its 13 hardcoded `runtime === 'claude'` / `runtime !== 'claude'` branches are folded into descriptor-driven `runtime.hostBehaviors` on `capabilities/claude/capability.json` (permission schema, `settings.local.json` scope routing, `.gsd-source` marker, effort frontmatter, canonical-workflow authorship, and more). Install/uninstall output is **byte-identical** for both the global skills layout and the local legacy layout (golden-parity asserted for both scopes); no other runtime changes. Removes the "add-a-host tax" of scattered string-equality checks for the tier-1 reference host. No user-facing change. (#2086)
