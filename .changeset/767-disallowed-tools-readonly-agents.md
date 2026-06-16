---
type: Changed
pr: 1081
---
**Read-only verifier/auditor agents now ship a Claude-Code `disallowedTools` deny-list** — the installer injects a framework-level write-tool deny-list into the Claude copies of the read-only verifier/auditor agents (gsd-verifier, gsd-plan-checker, gsd-integration-checker, gsd-doc-verifier, gsd-eval-auditor, gsd-ui-auditor, gsd-ui-checker) so write actions are blocked even if a tool grant is inherited. Injected for Claude only; other runtimes are unaffected. (#1081)
