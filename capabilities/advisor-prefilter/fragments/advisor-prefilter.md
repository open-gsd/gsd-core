## Advisor pre-filter (opt-in, advisory)

Before this workflow opens the next review gate, consult the Claude Code session advisor once and ask whether the work is final and internally consistent given everything already reviewed in this session. You run in the orchestrator's own context, so the advisor sees the whole transcript, including every edit made after the last reviewer pass.

**1. Silent no-op without an advisor.** If no advisor tool is present in your tool list for this session (no advisor is configured, the host is not Claude Code, or the host removed the tool), skip this section: print nothing, write nothing, and continue the workflow. That is a silent no-op, not an error and not a warning. Do not read host settings files to decide this, and do not simulate an advisor by reasoning in your own voice.

**2. Gather bounded evidence.** Run these read-only commands and keep only their output:

```bash
git rev-parse HEAD
git status --porcelain
```

When a phase directory is known, also list the review artifacts that exist in it (`*-REVIEW.md`, `*-VERIFICATION.md`, `*-SECURITY.md`, `*-UAT.md`) by name. Do not paste file contents into the consult.

**3. Make one consult.** Call the advisor tool exactly once with this question, naming the calling point (`verify:post` or `ship:pre`):

> "At `<point>`, given everything already reviewed in this session, is the current output final and internally consistent? List any edit made after the last reviewer or verifier pass, any partially applied fix, and any finding that was acknowledged but not resolved. Answer `consistent` or `drift-suspected` first, then at most five specific bullets."

Include the `git rev-parse HEAD` value, the `git status --porcelain` output and the artifact names in the question. One consult only, never a retry loop.

**4. Report and continue.** Print one advisory line, `advisor-prefilter (<point>): <consistent|drift-suspected>`, followed by the advisor's bullets verbatim when it answered `drift-suspected`. This never blocks and never redirects the workflow: the next gate runs regardless of the answer, and a `drift-suspected` answer is information for the reviewers that follow. Do not edit files, do not spawn a subagent, and do not re-run any reviewer on the strength of this answer. If the advisor call fails or returns nothing usable, print nothing and continue.

This does not replace `gsd-plan-checker`, `gsd-code-reviewer`, `gsd-verifier`, `gsd-security-auditor`, or any cross-AI reviewer lane. Those exist for specialised, decorrelated review and keep running unchanged. The advisor is a session-level model that may share a family with the executor, so its answer is a cheap early warning, never a verdict. Each consult sends the full session transcript to the advisor model at the advisor's rate, which is why `workflow.advisor_prefilter` is off by default.
