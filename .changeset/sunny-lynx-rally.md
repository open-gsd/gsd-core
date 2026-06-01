---
type: Fixed
pr: 570
---
Codex leak scanner now reads gsd-file-manifest.json to scope path checks to GSD-owned files only; bare ~/.claude (no trailing slash) is now replaced in converted Codex markdown; writeManifest now records agents/gsd-*.toml so the manifest-scoped scanner covers them
