'use strict';

// Core `external_job_waiting` half-state and its resume/pause contract (#1165): execute-plan defines it as a legal
// deferred half-state and skips waiting plans, safe_resume_gate checks the async-job manifest before declaring an
// illegal partial, resume-project and pause-work carry outstanding async jobs, planning-artifacts documents the
// manifest as a versioned stability contract with its trust boundary, and CONTEXT.md defines the term. The scheduler
// adapter that PRODUCES the manifest is the capability half (#1164). Was tests/external-job-waiting.test.cjs.

const MANIFEST_FIELDS = ['version', 'job_id', 'plan_id', 'backend', 'status', 'expected_artifacts', 'verification_command', 'resume_command', 'terminal_details'];
const MANIFEST_STATES = ['submitted', 'running', 'completed-unverified', 'failed', 'cancelled', 'timeout'];

module.exports = {
  id: 'external-job-waiting',
  issue: '#1165',
  check(ctx) {
    ctx.doc('gsd-core/workflows/execute-plan.md')
      .has(/only legal half-state is mid-production-commits/, 'the sync invariant (bug-3212) must be preserved')
      .has(/external_job_waiting/, 'the invariant must name the external_job_waiting half-state')
      .has(/\.planning\/async-jobs\//, 'the invariant must reference the async-job manifest path')
      // The test also accepted `legal.{0,12}deferral`; the file carries "legal deferred".
      .has(/legal deferred/i, 'the manifest state must be described as a legal deferred state, not illegal')
      .has(/async-jobs/, 'plan selection must reference the manifest')
      .has(/skip|exclude/i, 'execute-plan must skip or exclude waiting plans from (re-)dispatch');

    ctx.doc('gsd-core/workflows/execute-phase.md')
      .has(/<step name="safe_resume_gate"/, 'the safe_resume_gate step must exist')
      .has(/SUMMARY.md is missing/, 'the existing illegal-partial branch must be preserved')
      .has(/async-jobs/, 'the gate must reference async-job manifests')
      .has(/external_job_waiting/, 'the gate must name the legal half-state')
      .has(/never re-?dispatch/i, 'the gate must forbid re-dispatch (duplicate-execution guard)')
      .has(/planning-artifacts/, 'the gate must point to the manifest contract reference');

    ctx.doc('gsd-core/workflows/resume-project.md')
      .has(/async-jobs/, 'resume must probe async-job manifests')
      .has(/external_job_waiting/, 'resume must recognise the half-state')
      .has(/completed-unverified/, 'resume must handle the completed-unverified state')
      .has(/verif/i, 'completed jobs require verification before close');

    ctx.doc('gsd-core/workflows/pause-work.md')
      .has(/async/i, 'the pause gather must mention async external jobs')
      .has(/async_jobs|async-jobs/, 'the HANDOFF must record async job manifests');

    // The words below must be in the manifest-schema section itself, not anywhere in the page (`version`, `status`,
    // `failed` and `contract` occur all over planning-artifacts.md). The section runs to the next `##` or `###` heading.
    const artifacts = ctx.doc('docs/reference/planning-artifacts.md')
      .slice('### `.planning/async-jobs/<job>.json`', ['\n## ', '\n### '])
      .has(/contract/i, 'the manifest must be framed as a stability contract');
    for (const field of MANIFEST_FIELDS) artifacts.has(field, `the manifest schema must document the field ${field}`);
    for (const state of MANIFEST_STATES) artifacts.has(state, `the status enum must document the state ${state}`);
    artifacts
      .has(/find .planning\/async-jobs|grep -lE/, 'the glob-safe matching probe must be documented')
      .has(/2>\/dev\/null|\|\| true/, 'the probe must be null-safe')
      .has(/untrusted|confirm/i, 'manifest commands must be surfaced or confirmed, not auto-run')
      .has(/fail closed|fail-closed|surface the conflict/i, 'multiple or malformed manifests must fail closed')
      .has(/untrusted/i, 'the schema must state manifest commands are untrusted')
      .has(/confirm/i, 'user confirmation must be required before executing manifest commands')
      .has(/exact `?plan_id`?|match.{0,20}plan_id/i, 'the schema must specify exact plan_id matching')
      .has(/fail closed|fail-closed/i, 'fail-closed must be required on multiple or malformed manifests')
      .has(/every dispatch path/i, 'discovery must exclude waiting plans beyond has_summary');

    ctx.doc('CONTEXT.md')
      .has(/external_job_waiting|External-job-waiting/, 'the glossary must define the external_job_waiting domain term')
      .has(/async-jobs/, 'the glossary entry must reference the manifest');
  },
};
