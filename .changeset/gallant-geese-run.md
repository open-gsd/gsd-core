---
type: Fixed
pr: 1654
---
**`/gsd-new-project` AI Models prompt now exposes the `adaptive` model profile** — both onboarding paths (auto-mode and interactive) listed only Balanced/Quality/Budget/Inherit, so the `adaptive` profile (role-based cost optimization across Claude/Codex/Gemini/OpenRouter/local) was unreachable through `/gsd-new-project` despite being a first-class catalog entry and documented in CONFIGURATION.md. Both prompts now use the proven two-question split (Q1: Adaptive / Standard tier / Inherit; Q2: Quality / Balanced / Budget) already shipped for `/gsd:settings` (#3784), and both `config-new-project` example payloads list `adaptive`. (#1516)
