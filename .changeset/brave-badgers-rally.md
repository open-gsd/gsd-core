---
type: Fixed
pr: 5389
---
Hosts without a context metrics writer (Antigravity, Augment, CodeBuddy, Hermes, Qwen, Kimi, Kimi Code) no longer register the context monitor on tool events; they declare context-warnings unsupported, and a reinstall removes a stale registration while keeping user hooks.
