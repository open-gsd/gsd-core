# How to recover from an invalid verification status

**Goal:** Get a phase passing again when a command fails with `verification_status_invalid`, `/gsd-health` reports `W030`, or `verification status` answers `phase_dir_not_found`.

**Prerequisites:** A phase directory under `.planning/phases/` (the examples use `.planning/phases/01-foo`) and shell access to run `gsd-tools`.

---

## Identify the failing report

A phase's `*-VERIFICATION.md` may carry only `status: passed`, `gaps_found`, or `human_needed`. Any other value stops every command that reads the report. The error names the file, the value it found, and the accepted values:

```bash
node gsd-tools.cjs verification status .planning/phases/01-foo
```

```
Error: Verification report "/path/to/project/.planning/phases/01-foo/01-VERIFICATION.md" has status "verified", which is outside the closed set — accepted values: passed | gaps_found | human_needed. Recovery: set the report's frontmatter `status:` to one of passed | gaps_found | human_needed, or delete the report and re-run the phase's verification.
```

The command exits 1 and prints nothing to stdout. The value in the message is quoted, control characters are escaped, and it is cut at 120 characters.

`/gsd-health` (`validate health`) reports the same file as warning `W030` and exits 0, so the check does not fail on the defect it diagnoses:

```json
{
  "code": "W030",
  "message": "Phase 01-foo: Verification report \"/path/to/project/.planning/phases/01-foo/01-VERIFICATION.md\" has status \"verified\", which is outside the closed set — accepted values: passed | gaps_found | human_needed. ...",
  "fix": "Set the report frontmatter `status` to one of passed | gaps_found | human_needed, or delete the report and re-run the phase verification",
  "repairable": false
}
```

`W030` is not auto-fixable, so `/gsd-health --repair` leaves it in place. Open the file named in the message.

Legacy values fail the same way: `Passed`, `pending`, and `partial` are no longer folded into a known status.

---

## Fix the report

Pick one.

### Option 1: Correct the `status:` line

In the report's frontmatter, change `status:` to the value that matches what the verification found:

```yaml
---
phase: 01-foo
status: gaps_found
---
```

Do this only when the report genuinely reflects that outcome. Setting `passed` on a phase whose verification did not pass defeats the gate. When you are unsure what the report meant, prefer Option 2.

### Option 2: Delete the report and re-verify

```bash
rm .planning/phases/01-foo/01-VERIFICATION.md
```

The phase now reads `missing`, which routes to `/gsd-execute-phase`. Its verification step regenerates the report without re-running plans that already have a `SUMMARY.md`.

---

## Re-run verification

After deleting the report, ask for the verdict:

```bash
node gsd-tools.cjs verification status .planning/phases/01-foo
```

```json
{
  "status": "missing",
  "next_action": "No verification report found — the verify step never completed. Running execute-phase is safe here: it resumes at the verification gates and does not re-run plans that already have a SUMMARY.md (see #2868).",
  "next_command": "/gsd-execute-phase 01",
  "route": "execute-phase"
}
```

Run the `next_command`:

```bash
/gsd-execute-phase 01
```

If a report exists but its covered source changed afterward, the status is `stale`. Regenerate it with `/gsd-verify-work 01`. A report you corrected to `human_needed` routes there too:

```json
{
  "status": "human_needed",
  "next_command": "/gsd-verify-work 01",
  "route": "verify-work"
}
```

---

## Fix `phase_dir_not_found`

```json
{
  "status": "phase_dir_not_found",
  "next_command": "",
  "route": ""
}
```

The directory you passed does not exist. This is a usage error, not a verification state, so there is no next command. Re-running `/gsd-execute-phase` could re-run a phase already archived.

1. Resolve the real directory from the phase number:

   ```bash
   node gsd-tools.cjs find-phase 1
   ```

   The `directory` field (for example `.planning/phases/01-foo`) is the value to pass.
2. If `found` is `false`, the phase may have been archived by `/gsd-complete-milestone`. Look under `.planning/milestones/v<X.Y>-phases/`.
3. Re-run `verification status` with the resolved directory.

---

## Verify it worked

Run the status command against the phase directory:

```bash
node gsd-tools.cjs verification status .planning/phases/01-foo
```

The command now exits 0 and prints JSON whose `status` is one of `passed`, `gaps_found`, `human_needed`, `stale`, or `missing`. There is no `verification_status_invalid` error. Then run `/gsd-health` and confirm no `W030` entry remains.

---

## Related

- [`verification status` reference](../CLI-TOOLS.md#verification-status-the-verification-verdict-5118)
- [`/gsd-health` and `W030`](../COMMANDS.md#gsd-health)
- [Verify and ship](verify-and-ship.md)
- [Debug a failed execution](debug-a-failed-execution.md)
- [docs index](../README.md)
