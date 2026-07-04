#!/usr/bin/env node
'use strict';

/**
 * slurm-adapter.cjs — SLURM scheduler-adapter helper for the external-job
 * capability (#1164 / #1105).
 *
 * Thin CLI: runs bounded sbatch / squeue / sacct subprocesses and delegates
 * all parsing, manifest build/validate, and fail-closed writing to the pure
 * module (gsd-core/bin/lib/external-job.cjs). The pure module is fully unit-
 * tested; this script is the operator surface that needs a real cluster.
 *
 * Subcommands:
 *   submit  --plan <plan_id> --phase <phase> --expected <path>[,<path>] \
 *           --verify <cmd> --resume <cmd> -- <sbatch...>
 *   poll    --job <job_id> [--plan <plan_id>]
 *   show    --job <job_id>            (surface manifest status + commands; no auto-run)
 *
 * Trust boundary: this script never auto-runs verification_command or
 * resume_command from a manifest (planning-artifacts.md). `show` prints them
 * for explicit operator confirmation.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const m = require('../gsd-core/bin/lib/external-job.cjs');

const SUBMIT_TIMEOUT_MS = Number(process.env.GSD_SLURM_SUBMIT_TIMEOUT_MS || 30000);
const POLL_TIMEOUT_MS = Number(process.env.GSD_SLURM_POLL_TIMEOUT_MS || 15000);

function usage() {
  return [
    'usage: slurm-adapter.cjs <submit|poll|show> ...',
    '  submit --plan <id> --phase <n> --expected <p1,p2> --verify <cmd> --resume <cmd> -- sbatch --parsable ...',
    '  poll   --job <job_id> [--plan <plan_id>]',
    '  show   --job <job_id>',
  ].join('\n');
}

function parseFlags(argv) {
  const out = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out['--'] = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      out[a.slice(2)] = v;
      i++;
    } else {
      rest.push(a);
    }
  }
  out._ = rest;
  return out;
}

function findPlanningDir(start) {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.planning'))) return path.join(dir, '.planning');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ExitError(1, 'could not locate a .planning directory (walked up 10 levels)');
}

function cmdSubmit(flags) {
  const plan = flags.plan;
  const phase = flags.phase;
  const sbatchCmd = flags['--'];
  if (!plan || phase === undefined || !Array.isArray(sbatchCmd) || sbatchCmd.length === 0) {
    throw new ExitError(1, 'submit requires --plan, --phase, and an sbatch command after --\n' + usage());
  }
  const expected = (flags.expected || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (expected.length === 0) throw new ExitError(1, 'submit requires --expected (comma-separated artifact paths)');
  const verify = flags.verify;
  const resume = flags.resume || ('/gsd:execute-phase ' + phase);
  if (!verify) throw new ExitError(1, 'submit requires --verify (the command that verifies job output)');

  let stdout;
  try {
    stdout = execFileSync(sbatchCmd[0], sbatchCmd.slice(1), {
      encoding: 'utf8',
      timeout: SUBMIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    throw new ExitError(1, 'sbatch failed: ' + (e.message || String(e)));
  }
  const parsed = m.parseSbatchParsable(stdout);
  if (!parsed.ok) {
    throw new ExitError(1, 'could not parse sbatch --parsable output (kind=' + parsed.kind + '): ' + parsed.raw);
  }
  const manifest = m.buildManifest({
    plan_id: plan,
    phase,
    job_id: parsed.job_id,
    backend: 'slurm',
    submit_command: sbatchCmd.join(' '),
    status: 'submitted',
    expected_artifacts: expected,
    verification_command: verify,
    resume_command: resume,
  });
  const planningDir = findPlanningDir();
  const res = m.writeManifest(manifest, planningDir);
  if (!res.ok) {
    throw new ExitError(1, 'writeManifest refused (' + res.kind + '): ' + res.message);
  }
  process.stdout.write('submitted job ' + parsed.job_id + ' for plan ' + plan + '\n');
  process.stdout.write('manifest: ' + res.path + '\n');
  process.stdout.write('state: external_job_waiting (SUMMARY deferred)\n');
}

function cmdPoll(flags) {
  const jobId = flags.job;
  if (!jobId) throw new ExitError(1, 'poll requires --job <job_id>\n' + usage());
  const planningDir = findPlanningDir();
  const manifestFile = m.manifestPath(planningDir, jobId);
  if (!fs.existsSync(manifestFile)) {
    throw new ExitError(1, 'no manifest for job ' + jobId + ' at ' + manifestFile);
  }
  const existing = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  let rawState = null;
  try {
    const out = execFileSync('squeue', ['-h', '-j', jobId, '-o', '%i %T'], {
      encoding: 'utf8', timeout: POLL_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }).trim();
    const line = out.split('\n')[0];
    const parsed = m.parseSqueueLine(line || '');
    if (parsed) rawState = parsed.state;
  } catch (_e) { /* squeue empty/failed — fall back to sacct */ }
  if (!rawState) {
    try {
      const out = execFileSync('sacct', ['-X', '-P', '-j', jobId, '-o', 'JobID,State'], {
        encoding: 'utf8', timeout: POLL_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      }).trim();
      for (const line of out.split('\n').slice(1)) {
        const parsed = m.parseSacctRow(line.split('|'));
        if (parsed) { rawState = parsed.state; break; }
      }
    } catch (e) {
      throw new ExitError(1, 'both squeue and sacct failed: ' + (e.message || String(e)));
    }
  }
  const mapped = m.mapSlurmState(rawState || '');
  if (!mapped) throw new ExitError(1, 'unmapped SLURM state "' + rawState + '" — not guessing; inspect manually');

  const updated = m.buildManifest(
    Object.assign({}, existing, { status: mapped, terminal_details: existing.terminal_details || null }),
    { clock: { nowIso: () => existing.submitted_at } },
  );
  const res = m.writeManifest(updated, planningDir);
  if (!res.ok) throw new ExitError(1, 'writeManifest refused (' + res.kind + '): ' + res.message);
  process.stdout.write(JSON.stringify({ job_id: jobId, slurm_state: rawState, manifest_status: mapped, path: res.path }) + '\n');
}

function cmdShow(flags) {
  const jobId = flags.job;
  if (!jobId) throw new ExitError(1, 'show requires --job <job_id>\n' + usage());
  const planningDir = findPlanningDir();
  const manifestFile = m.manifestPath(planningDir, jobId);
  if (!fs.existsSync(manifestFile)) {
    throw new ExitError(1, 'no manifest for job ' + jobId + ' at ' + manifestFile);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  process.stdout.write('job ' + manifest.job_id + ' (plan ' + manifest.plan_id + ', backend ' + manifest.backend + ')\n');
  process.stdout.write('status: ' + manifest.status + '\n');
  if (manifest.terminal_details) {
    process.stdout.write('terminal_details: ' + JSON.stringify(manifest.terminal_details) + '\n');
  }
  // Trust boundary: surface commands for confirmation, never auto-run.
  process.stdout.write('\nManifest commands (UNTRUSTED — confirm before running):\n');
  process.stdout.write('  submit_command:       ' + manifest.submit_command + '\n');
  process.stdout.write('  verification_command: ' + manifest.verification_command + '\n');
  process.stdout.write('  resume_command:       ' + manifest.resume_command + '\n');
}

function main() {
  const [, , sub, ...rest] = process.argv;
  const flags = parseFlags(rest);
  if (sub === 'submit') cmdSubmit(flags);
  else if (sub === 'poll') cmdPoll(flags);
  else if (sub === 'show') cmdShow(flags);
  else throw new ExitError(1, usage());
  return 0;
}

runMain(main);
