---
type: Security
pr: 1585
---
**Prompt-injection defence extended to the untrusted-input surface (LLM-playbook principle 12)** — the read-injection scanner now also scans WebFetch/WebSearch output (closing the largest untrusted channel at ingress), the 8 research/doc-ingest agents isolate fetched/read content as data-not-instructions via a shared `untrusted-input-boundary` reference, and an opt-in `security.injection_blocking` upgrades HIGH-confidence detections from advisory to blocking (default advisory, unchanged). Based on arXiv 2506.05739 (PPA), 2507.15219 (PromptArmor), 2504.20472, 2503.00061.
