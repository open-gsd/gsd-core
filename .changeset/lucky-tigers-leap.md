---
type: Added
pr: 1966
---
<!-- docs-exempt: VS Code extension is a repo-local reference module; installation instructions are in the #1942 issue body + ADR-1239 Phase D context. No standalone docs/ file needed. -->
**GSD now ships a repo-local VS Code extension** — a buildable extension (`vscode/extension.js` + `vscode/package.json`) that registers `gsd.invoke` (dispatches through the GSD command-routing hub) in the VS Code command palette. A reachability test proves the handler dispatches through the engine (keystone wired). Not Marketplace-published; mirrors the OpenCode plugin's bar. (#1966)
