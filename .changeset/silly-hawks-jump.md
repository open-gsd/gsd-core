---
type: Fixed
pr: 5395
---
**Codex cleanup preserves user configuration** — Uninstall and full-to-core profile changes keep MCP servers, plugins, project trust, marketplaces and user agent tuning added after the GSD marker while removing only managed content. Markerless cleanup now preserves trailing user comments, removes the legacy injected keys only inside `[features]`, and drops a managed table only when its body is empty, so a key after a blank line or a same-named key in another table survives; marker text that is not a standalone marker line no longer claims ownership of the file. Install and update likewise recognize only a standalone marker line and remove whitespace-padded ownership lines before regenerating the managed block.
