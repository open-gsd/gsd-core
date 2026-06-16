---
type: Changed
pr: 1157
---
Capability manifests now declare runtime compatibility through a validated runtimeCompat contract, and runtime descriptor interpreters now read artifact layout, skills-home, and hook-surface facts directly from runtime Capability descriptors instead of parallel runtime-name allowlists or fallbacks. This preserves existing supported runtime behavior while making future descriptor-backed runtimes additive.
