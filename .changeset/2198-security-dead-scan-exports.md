---
type: Fixed
pr: 2211
---
**Dead security scan exports removed; injection-scan docs corrected to match reality** — `scanEntropyAnomalies` and `shannonEntropy` were dead code with zero production callers (live hooks inline their own patterns for independence). REQ-SCAN-INJ-02/-03 now accurately describe what runs live (injection patterns, invisible Unicode) vs CI-only (base64-decode, codebase scan). (#2198)
