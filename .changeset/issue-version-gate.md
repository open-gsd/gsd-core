---
type: Added
pr: 1181
---
Bug-report issues that lack a valid GSD Version are now auto-closed on open by a new `version-gate.yml` GitHub Actions workflow. GitHub Issue Forms only enforce `required: true` in the web UI, so issues filed via the REST API, `gh issue create`, or AI reporters can arrive without a version; values like `idk`, `_No response_`, or an empty field are treated as missing. Affected issues receive a closing comment with instructions to add the version (e.g. `1.18.0`) and reopen; maintainers can add the `version-exempt` label to opt an issue out.
