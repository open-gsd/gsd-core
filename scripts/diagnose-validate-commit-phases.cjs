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
 *   - untraced: wall time of the hook exactly as the test runs it;
 *   - traced:   `bash -x` with a PS4 that stamps every command with an epoch
 *               millisecond and its line number (scripts/lib/xtrace-phase-timing.cjs
 *               turns the stamps into per-line costs).
 *
 * `--load N` runs N busy node processes alongside, standing in for the
 * conformance tier's `--test-concurrency=4` on a small runner.
 *
 * Diagnostic only: it asserts nothing and exits 0 unless it cannot run. A hook
 * run that exceeds its bound is killed and reported (signal SIGKILL), not thrown.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const {
  stampPs4,
  parseTimedXtrace,
  phaseCosts,
  slowestLines,
  abbreviate,
} = require('./lib/xtrace-phase-timing.cjs');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-validate-commit.sh');
const BASH = '/bin/bash';
const HOOK_BOUND_MS = 30000;
const VERSION_PROBE_BOUND_MS = 10000;
const TRACE_MAX_BYTES = 1024 * 1024 * 1024;
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

function runHook(project, command, { trace }) {
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
  };
  if (trace) env.PS4 = stampPs4(STAMP_COMMAND);
  const started = process.hrtime.bigint();
  const r = spawnSync(BASH, trace ? ['-x', HOOK] : [HOOK], {
    cwd: project,
    env,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    timeout: HOOK_BOUND_MS,
    killSignal: 'SIGKILL',
    maxBuffer: TRACE_MAX_BYTES,
  });
  const wallMs = Number((process.hrtime.bigint() - started) / 1000000n);
  return { wallMs, status: r.status, signal: r.signal, stderr: r.stderr || '' };
}

function startLoad(count) {
  return Array.from({ length: count }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
}

function stopLoad(children) {
  for (const child of children) child.kill('SIGKILL');
}

function bashVersionLine() {
  const r = spawnSync(BASH, ['--version'], { encoding: 'utf8', timeout: VERSION_PROBE_BOUND_MS });
  return (r.stdout || 'unknown').split('\n')[0];
}

function report(opts) {
  const project = makeProject();
  const source = fs.readFileSync(HOOK, 'utf8').split('\n');
  const out = [];
  out.push('# validate-commit phase timing (#5473)', '');
  out.push(`- shell: \`${BASH}\` (${bashVersionLine()})`);
  out.push(`- platform: ${process.platform}/${process.arch}, ${os.cpus().length} cpus, node ${process.version}`);
  out.push(`- background load: ${opts.load} busy process(es)`, '');
  const load = startLoad(opts.load);
  try {
    for (const scenario of scenarios()) {
      const untraced = runHook(project, scenario.command, { trace: false });
      const traced = runHook(project, scenario.command, { trace: true });
      const { costs, floorMs, totalMs } = phaseCosts(parseTimedXtrace(traced.stderr));
      out.push(`## ${scenario.name}`, '');
      out.push(
        `untraced wall ${untraced.wallMs} ms (exit ${untraced.status}${untraced.signal ? `, ${untraced.signal}` : ''}); ` +
        `traced span ${totalMs} ms${traced.signal ? ` (${traced.signal})` : ''}; ` +
        `stamp floor ${floorMs} ms/command; command ${scenario.command.length} bytes`,
        '',
      );
      out.push('| hook line | total ms | max ms | runs | source | traced value |');
      out.push('|---:|---:|---:|---:|---|---|');
      for (const c of slowestLines(costs, opts.top)) {
        const src = abbreviate(source[c.line - 1] || '', 70).replace(/\|/g, '\\|');
        const val = abbreviate(c.sample, 60).replace(/\|/g, '\\|');
        out.push(`| ${c.line} | ${c.totalMs} | ${c.maxMs} | ${c.count} | \`${src}\` | \`${val}\` |`);
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

module.exports = { scenarios, parseArgs };

if (require.main === module) runMain(run);
