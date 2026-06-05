---
type: Added
pr: 664
---
**Research is now cached, curated-first, and code-governed** — a content-addressed Research Store (per-source TTL), a single provider waterfall with confidence tiers, and registry-API package legitimacy replace the per-agent prose waterfall and the slopcheck bolt-on. (#664) Confidence is now verification-evidence-driven: provider identity alone no longer yields HIGH; HIGH requires ground-truth corroboration (e.g. `legitimacyVerdict: 'OK'`), authority alone caps at MEDIUM, and SLOP caps at LOW.
