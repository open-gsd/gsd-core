---
type: Added
pr: 1221
---
**Async external jobs can now defer an Execute step legally (`external_job_waiting`).** An Execute step that dispatches a long-running external job and commits a `.planning/async-jobs/<job>.json` manifest — deferring `SUMMARY.md` — is now recognized as a *legal deferred state*, not an illegal partial-plan state. `execute-phase` safe-resume, `resume-project`, and `pause-work` reconcile against the manifest instead of re-dispatching (which would duplicate the external compute). This defines the versioned, scheduler-agnostic manifest **stability contract** consumed by the core loop; the scheduler adapter that *produces* manifests is the capability half (#1164). (#1165)
