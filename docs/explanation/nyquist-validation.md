# Nyquist validation explained

How GSD decides, before any code is written, how each requirement will be verified, and how `/gsd-validate-phase` closes the gaps on phases that predate that step. The setting is `workflow.nyquist_validation` in the [configuration reference](../CONFIGURATION.md); the phase it belongs to is walked through in [Plan a phase](../how-to/plan-a-phase.md).

## The Nyquist layer: coverage mapped before code

During plan-phase research, GSD maps automated test coverage to each phase requirement before any code is written. The researcher detects your existing test infrastructure, maps each requirement to a specific test command, and identifies any test scaffolding that must be created before implementation begins (Wave 0 tasks). The plan-checker enforces this as an 8th verification dimension: plans where tasks lack automated verify commands will not be approved.

**Output:** `{phase}-VALIDATION.md` — the feedback contract for the phase.

**Disable:** Set `workflow.nyquist_validation: false` in `/gsd-settings` for rapid prototyping phases where test infrastructure isn't the focus.

## Retroactive validation with `/gsd-validate-phase`

For phases executed before Nyquist validation existed, or for existing codebases with only traditional test suites, retroactively audit and fill coverage gaps:

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

The auditor never modifies implementation code — only test files and VALIDATION.md. If a test reveals an implementation bug, it's flagged as an escalation for you to address.

## Related

- [`/gsd-validate-phase`](../COMMANDS.md#gsd-validate-phase)
- [`workflow.nyquist_validation`](../CONFIGURATION.md)
- [User Guide](../USER-GUIDE.md)
