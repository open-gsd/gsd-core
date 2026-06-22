---
type: Changed
pr: 1583
---
**eval-auditor scoring moved into a deterministic `eval.score` query verb (LLM-playbook principle 10)** — coverage/infra/overall arithmetic and verdict banding are computed in code (`gsd-tools query eval.score`) instead of by the model. Based on arXiv 2601.15130 (Plausibility Trap / DPDM), 2508.15754 (Tool-Integrated Reasoning), 2507.10281 (Table Agent); 2504.00406 / 2510.15955 supporting.
