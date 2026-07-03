---
type: Added
pr: 1965
---
<!-- docs-exempt: pi extension is a reference host-plugin module; installation instructions are in the #1944 issue body + ADR-1239 Phase D context. No standalone docs/ file needed. -->
**GSD now ships a pi extension** — a real, jiti-loadable ExtensionAPI module (`pi/gsd.cjs`) that registers `/gsd` (dispatches through the GSD command-routing hub) + `gsd_invoke` tool + `tool_call` event, installable at `~/.pi/agent/extensions/`. A reachability test proves the `/gsd` handler dispatches through the engine (keystone wired, not just registered on a mock). (#1965)
