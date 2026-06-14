'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// #1165: core `external_job_waiting` half-state + resume/pause contract.
// The scheduler adapter that PRODUCES the manifest is the capability half (#1164);
// here we assert only the CORE contract that DEFINES and CONSUMES it.

test('execute-plan invariant defines external_job_waiting as a legal deferred half-state', () => {
  const w = read('gsd-core/workflows/execute-plan.md');
  assert.match(w, /only legal half-state is mid-production-commits/, 'sync invariant (bug-3212) must be preserved');
  assert.match(w, /external_job_waiting/, 'must name the external_job_waiting half-state');
  assert.match(w, /\.planning\/async-jobs\//, 'must reference the async-job manifest path');
  assert.match(w, /legal deferred|legal.{0,12}deferral/i, 'manifest state must be described as legal, not illegal');
});

test('safe_resume_gate checks async-job manifest before declaring an illegal partial', () => {
  const w = read('gsd-core/workflows/execute-phase.md');
  assert.match(w, /<step name="safe_resume_gate"/, 'safe_resume_gate step must exist');
  assert.match(w, /SUMMARY.md is missing/, 'existing illegal-partial branch preserved');
  assert.match(w, /async-jobs/, 'gate must reference async-job manifests');
  assert.match(w, /external_job_waiting/, 'gate must name the legal half-state');
  assert.match(w, /never re-?dispatch/i, 'gate must forbid re-dispatch (duplicate-execution guard)');
  assert.match(w, /planning-artifacts/, 'gate must point to the manifest contract reference');
});

test('resume-project reconciles outstanding async jobs as primary context', () => {
  const w = read('gsd-core/workflows/resume-project.md');
  assert.match(w, /async-jobs/, 'resume must probe async-job manifests');
  assert.match(w, /external_job_waiting/, 'resume must recognise the half-state');
  assert.match(w, /completed-unverified/, 'resume must handle the completed-unverified state');
  assert.match(w, /verif/i, 'completed jobs require verification before close');
});

test('pause-work captures outstanding async jobs in the handoff', () => {
  const w = read('gsd-core/workflows/pause-work.md');
  assert.match(w, /async/i, 'pause gather must mention async external jobs');
  assert.match(w, /async_jobs|async-jobs/, 'HANDOFF must record async job manifests');
});

test('planning-artifacts documents the async-job manifest as a versioned stability contract', () => {
  const w = read('docs/reference/planning-artifacts.md');
  assert.match(w, /async-jobs\/<job>\.json/, 'schema doc section must exist');
  assert.match(w, /contract/i, 'must be framed as a stability contract');
  for (const field of ['version', 'job_id', 'plan_id', 'backend', 'status', 'expected_artifacts', 'verification_command', 'resume_command', 'terminal_details']) {
    assert.match(w, new RegExp(field), `manifest schema must document field: ${field}`);
  }
  for (const st of ['submitted', 'running', 'completed-unverified', 'failed', 'cancelled', 'timeout']) {
    assert.match(w, new RegExp(st), `status enum must document state: ${st}`);
  }
  assert.match(w, /find .planning\/async-jobs|grep -lE/, 'must document the glob-safe matching probe');
  assert.match(w, /2>\/dev\/null|\|\| true/, 'probe must be null-safe');
});

test('CONTEXT.md glossary defines the external_job_waiting domain term', () => {
  const w = read('CONTEXT.md');
  assert.match(w, /external_job_waiting|External-job-waiting/, 'glossary must define the new domain term');
  assert.match(w, /async-jobs/, 'glossary entry must reference the manifest');
});

test('execute-plan plan-selection excludes external_job_waiting plans', () => {
  const w = read('gsd-core/workflows/execute-plan.md');
  assert.match(w, /external_job_waiting/, 'execute-plan selection must name the half-state');
  assert.match(w, /async-jobs/, 'execute-plan selection must reference the manifest');
  assert.match(w, /skip|exclude/i, 'execute-plan must skip/exclude waiting plans from (re-)dispatch');
});

test('safe_resume_gate treats manifest commands as untrusted and fails closed on conflicts', () => {
  const w = read('docs/reference/planning-artifacts.md');
  assert.match(w, /untrusted|confirm/i, 'manifest commands must be surfaced/confirmed, not auto-run');
  assert.match(w, /fail closed|fail-closed|surface the conflict/i, 'multiple/malformed manifests must fail closed');
});

test('planning-artifacts documents the manifest trust boundary and exact matching', () => {
  const w = read('docs/reference/planning-artifacts.md');
  assert.match(w, /untrusted/i, 'schema must state manifest commands are untrusted');
  assert.match(w, /confirm/i, 'must require user confirmation before executing manifest commands');
  assert.match(w, /exact `?plan_id`?|match.{0,20}plan_id/i, 'must specify exact plan_id matching');
  assert.match(w, /fail closed|fail-closed/i, 'must require fail-closed on multiple/malformed manifests');
});

test('execute-phase discovery excludes external_job_waiting plans from every dispatch path', () => {
  const w = read('docs/reference/planning-artifacts.md');
  assert.match(w, /every dispatch path/i, 'discovery must exclude waiting plans beyond has_summary');
});
