---
type: Added
pr: 1946
---
**Host-integration descriptors now carry an `extensionEvents` vocabulary** — the extension-system event surface (OpenCode, pi) is a separate descriptor field from managed `hookEvents`, so OpenCode declares `extensionEvents:opencode` without conflicting with the hooksSurface:none invariant. (#1946)
