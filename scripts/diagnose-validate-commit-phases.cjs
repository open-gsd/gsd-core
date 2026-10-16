#!/usr/bin/env node
'use strict';

/**
 * #5473 — where does hooks/gsd-validate-commit.sh spend its time on a 112KB
 * whitespace-padded command under /bin/bash 3.2 (macOS)?
 *
 * tests/hooks-opt-in.test.cjs's "suffix window still sees an option after a
 * 112KB command" row costs ~5s on the macOS conformance job against a 10s
 * kill bound, and ~12x the same-size unpadded row. This script runs the real
 * hook two ways per scenario and prints a per-line cost table:
 *
 *   - untraced: wall time of the hook exactly as the test runs it, repeated
 *               (min / median / max), because the effect under study is
 *               noisy on a shared runner;
 *   - traced:   `bash -x` with a PS4 that stamps every command with an epoch
 *               millisecond, its line number and its function
 *               (scripts/xtrace-phase-timing.cjs turns the stamps into
 *               per-line costs).
 *
 * Reading the traced numbers: every traced command pays one stamp (a perl
 * spawn), measured and reported below, and xtrace prints each 112KB expansion,
 * a cost the untraced run does not have. The traced span is therefore NOT
 * comparable to the untraced wall time; use it to RANK lines, not to total them.
 * bash 3.2 numbers LINENO relative to the enclosing function, so lines inside a
 * function are reported by function name and function-relative line.
 *
 * `--load N` runs N busy node processes alongside, standing in for the
 * conformance tier's `--test-concurrency=4` on a small runner. They are CPU
 * spin loops; the real tier's concurrent files also fork heavily.
 *
 * Diagnostic only: it asserts nothing and exits 0 unless it cannot run. A hook
 * run that exceeds its bound or overflows its buffer is reported, not thrown.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const {
  stampPs4,
  ps4AssignmentFile,
  parseTimedXtrace,
  phaseCosts,
  slowestLines,
  abbreviate,
} = require('./xtrace-phase-timing.cjs');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-validate-commit.sh');
const BASH = '/bin/bash';
const HOOK_BOUND_MS = 30000;
const PROBE_BOUND_MS = 10000;
const TRACE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_LOAD = 64;
const UNTRACED_RUNS = 3;
const CALIBRATION_COMMANDS = 200;
const LOAD_LIFETIME_MS = 5 * 60 * 1000;
// Mirrors the test: 112KB stays under Linux's MAX_ARG_STRLEN (131072).
const PAD_BYTES = 112 * 1024;
// Millisecond clock for bash 3.2, which has neither EPOCHREALTIME nor printf %(%s)T.
// perl, not node: it is stamped once per traced command, and node's ~40ms startup
// would dwarf the costs being measured.
const STAMP_COMMAND = "perl -MTime::HiRes=time -e 'printf \"%d\", time*1000'";

const bodyOf = (kb) =>
  Array.from({ length: Math.ceil((kb * 1024) / 63) }, () => 'x'.repeat(62)).join('\n');

/** Same command shapes as tests/hooks-opt-in.test.cjs (#4492 rows). */
function scenarios() {
  const base = `git commit -m "$(cat${' '.repeat(PAD_BYTES)} <<'EOF'\nfeat: x\nEOF\n)"`;
  return [
    { name: 'padded control (no trailing option)', command: base },
    { name: 'padded + trailing --cleanup=verbatim', command: `${base} --cleanup=verbatim` },
    {
      name: 'unpadded 112KB body (comparison)',
      command: `git commit --allow-empty -m "$(cat <<'EOF'\nfeat: ${'x'.repeat(66)}\n${bodyOf(112)}\nEOF\n)"`,
    },
  ];
}

function parseArgs(argv) {
  const opts = { load: 0, top: 15 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--load' && arg !== '--top') {
      throw new ExitError(2, `diagnose-validate-commit-phases: unknown argument "${arg}"`);
    }
    const value = Number(argv[++i]);
    if (!Number.isInteger(value) || value < 0) {
      throw new ExitError(2, `diagnose-validate-commit-phases: ${arg} needs a non-negative integer`);
    }
    if (arg === '--load' && value > MAX_LOAD) {
      throw new ExitError(2, `diagnose-validate-commit-phases: --load is capped at ${MAX_LOAD}`);
    }
    opts[arg === '--load' ? 'load' : 'top'] = value;
  }
  return opts;
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5473-'));
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ model_profile: 'balanced', hooks: { community: true } }),
  );
  return dir;
}

// `ps4File` is a BASH_ENV file (see ps4AssignmentFile): bash 5.x ignores the
// command substitution in an exported PS4, so the stamp is assigned in-shell.
function hookEnv(ps4File) {
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
  };
  if (ps4File) env.BASH_ENV = ps4File;
  return env;
}

function runHook(project, command, ps4File) {
  const started = process.hrtime.bigint();
  const r = spawnSync(BASH, ps4File ? ['-x', HOOK] : [HOOK], {
    cwd: project,
    env: hookEnv(ps4File),
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    timeout: HOOK_BOUND_MS,
    killSignal: 'SIGKILL',
    maxBuffer: TRACE_MAX_BYTES,
  });
  const wallMs = Number((process.hrtime.bigint() - started) / 1000000n);
  return {
    wallMs,
    status: r.status,
    signal: r.signal,
    error: r.error ? r.error.code || r.error.message : null,
    stderr: r.stderr || '',
  };
}

/** Cost of one stamp: a run of no-op commands under the same PS4. */
function calibrateStampMs(ps4File, nonce) {
  const script = Array.from({ length: CALIBRATION_COMMANDS }, () => ':').join('\n');
  const r = spawnSync(BASH, ['-x', '-c', script], {
    env: hookEnv(ps4File),
    encoding: 'utf8',
    timeout: PROBE_BOUND_MS,
    killSignal: 'SIGKILL',
  });
  const { totalMs } = phaseCosts(parseTimedXtrace(r.stderr || '', nonce));
  return totalMs / CALIBRATION_COMMANDS;
}

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)];
}

function startLoad(count) {
  // Self-terminating: a parent that is SIGKILLed cannot orphan a spinner forever.
  const busy = `const end=Date.now()+${LOAD_LIFETIME_MS};while(Date.now()<end){}`;
  return Array.from({ length: count }, () =>
    spawn(process.execPath, ['-e', busy], { stdio: 'ignore' }));
}

function stopLoad(children) {
  for (const child of children) child.kill('SIGKILL');
}

function bashVersionLine() {
  const r = spawnSync(BASH, ['--version'], { encoding: 'utf8', timeout: PROBE_BOUND_MS });
  return (r.stdout || 'unknown').split('\n')[0];
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

function whereCell(c, source) {
  if (c.fn) return { line: `${c.fn}():${c.line}`, text: '(function-relative line)' };
  return { line: String(c.line), text: abbreviate(source[c.line - 1] || '', 70) };
}

function report(opts) {
  const project = makeProject();
  const source = fs.readFileSync(HOOK, 'utf8').split('\n');
  const nonce = crypto.randomBytes(6).toString('hex');
  const ps4File = path.join(project, '.ps4.sh');
  fs.writeFileSync(ps4File, ps4AssignmentFile(stampPs4(STAMP_COMMAND, nonce)));
  const stampMs = calibrateStampMs(ps4File, nonce);
  const out = [];
  out.push('# validate-commit phase timing (#5473)', '');
  out.push(`- shell: \`${BASH}\` (${bashVersionLine()})`);
  out.push(`- platform: ${process.platform}/${process.arch}, ${os.cpus().length} cpus, node ${process.version}`);
  out.push(`- background load: ${opts.load} busy process(es)`);
  out.push(`- stamp overhead: ${stampMs.toFixed(1)} ms per traced command (measured over ${CALIBRATION_COMMANDS} no-ops)`);
  out.push('- traced numbers rank lines; they are not comparable to untraced wall time (every command pays a stamp and xtrace prints each 112KB expansion)', '');
  const load = startLoad(opts.load);
  try {
    for (const scenario of scenarios()) {
      const walls = [];
      let last = null;
      for (let i = 0; i < UNTRACED_RUNS; i++) {
        last = runHook(project, scenario.command, null);
        walls.push(last.wallMs);
      }
      walls.sort((a, b) => a - b);
      const traced = runHook(project, scenario.command, ps4File);
      const { costs, totalMs } = phaseCosts(parseTimedXtrace(traced.stderr, nonce));
      out.push(`## ${scenario.name}`, '');
      out.push(
        `untraced wall ms (${UNTRACED_RUNS} runs): min ${walls[0]} / median ${median(walls)} / max ${walls[walls.length - 1]}` +
        ` (last exit ${last.status}${last.signal ? `, ${last.signal}` : ''}${last.error ? `, ${last.error}` : ''}); ` +
        `traced span ${totalMs} ms${traced.signal ? ` (${traced.signal})` : ''}${traced.error ? ` (${traced.error})` : ''}; ` +
        `command ${scenario.command.length} bytes`,
        '',
      );
      out.push('| hook line | total ms | max ms | runs | source | traced value |');
      out.push('|---:|---:|---:|---:|---|---|');
      for (const c of slowestLines(costs, opts.top)) {
        const where = whereCell(c, source);
        out.push(`| ${cell(where.line)} | ${c.totalMs} | ${c.maxMs} | ${c.count} | \`${cell(where.text)}\` | \`${cell(abbreviate(c.sample, 60))}\` |`);
      }
      out.push('');
    }
  } finally {
    stopLoad(load);
    fs.rmSync(project, { recursive: true, force: true });
  }
  return out.join('\n');
}

function run(argv = process.argv.slice(2)) {
  if (process.platform === 'win32') {
    throw new ExitError(2, 'diagnose-validate-commit-phases: needs a unix /bin/bash (macOS or Linux)');
  }
  if (!fs.existsSync(BASH)) {
    throw new ExitError(2, `diagnose-validate-commit-phases: ${BASH} not found`);
  }
  const text = report(parseArgs(argv));
  process.stdout.write(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${text}\n`);
  return 0;
}

module.exports = { scenarios, parseArgs, MAX_LOAD, STAMP_COMMAND };

if (require.main === module) runMain(run);
