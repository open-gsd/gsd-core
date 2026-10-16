#!/usr/bin/env node
'use strict';

/**
 * #5473 — where does hooks/gsd-validate-commit.sh spend its time on a 112KB
 * whitespace-padded command under /bin/bash 3.2 (macOS)?
 *
 * tests/hooks-opt-in.test.cjs's "suffix window still sees an option after a
 * 112KB command" row costs ~5s on the macOS conformance job against a 10s
 * kill bound, and ~12x the same-size unpadded row. This script runs the real
 * hook two ways per scenario and prints where the time goes:
 *
 *   - untraced: wall time of the hook exactly as the test runs it, repeated
 *               (min / median / max), because the effect under study is
 *               noisy on a shared runner;
 *   - traced:   a copy of the hooks directory whose hook has one line inserted
 *               after its shebang (PS4 assigned, xtrace on), so every command
 *               is stamped with an epoch millisecond, its line number and its
 *               function (scripts/xtrace-phase-timing.cjs turns the stamps
 *               into per-line and per-region costs, shifted back to the
 *               hook's own line numbers).
 *
 * Reading the traced numbers: every traced command pays one stamp (a perl
 * spawn), measured and reported below, and xtrace prints each 112KB expansion,
 * a cost the untraced run does not have. The traced span is therefore NOT
 * comparable to the untraced wall time; use it to RANK lines, not to total them.
 * A gap is the previous command's execution plus the next command's expansion,
 * so each line carries two numbers (see xtrace-phase-timing.cjs).
 *
 * `--load N` runs N processes that fork node in a loop alongside the hook,
 * standing in for the conformance tier's `--test-concurrency=4` (four test
 * files, most of them spawning subprocesses) on a small runner.
 *
 * It exits 1 if it could not produce a usable trace (so a broken diagnostic
 * is a red step, not a silent empty report); it asserts nothing about the
 * numbers. A hook run that exceeds its bound is killed and reported, not thrown.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const {
  stampPs4,
  TRACE_PS4_FILE,
  INJECTED_LINES,
  injectTracing,
  parseTimedXtrace,
  shiftLines,
  phaseCosts,
  slowestLines,
  rollupByRegion,
  abbreviate,
} = require('./xtrace-phase-timing.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const HOOK_NAME = 'gsd-validate-commit.sh';
const HOOK = path.join(HOOKS_DIR, HOOK_NAME);
const BASH = '/bin/bash';
const HOOK_BOUND_MS = 30000;
const PROBE_BOUND_MS = 10000;
const MAX_TRACE_BYTES = 256 * 1024 * 1024;
const MAX_LOAD = 64;
const UNTRACED_RUNS = 3;
const CALIBRATION_COMMANDS = 200;
const REGION_LINES = 50;
const LOAD_LIFETIME_MS = 5 * 60 * 1000;
// Mirrors the test: 112KB stays under Linux's MAX_ARG_STRLEN (131072).
const PAD_BYTES = 112 * 1024;
// Millisecond clock for bash 3.2, which has neither EPOCHREALTIME nor printf %(%s)T.
// perl, not node: it is stamped once per traced command, and node's ~40ms startup
// would dwarf the costs being measured.
// LC_ALL=C and 2>/dev/null: perl prints a locale warning to stderr on EVERY stamp
// when the inherited LANG/LC_* names a locale the machine lacks, and stderr is
// the trace stream, so each warning would corrupt the command it follows.
const STAMP_COMMAND = "LC_ALL=C perl -MTime::HiRes=time -e 'printf \"%d\", time*1000' 2>/dev/null";

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

/**
 * A copy of the hooks directory whose hook carries the tracing line, the PS4
 * text beside it, and a no-op script for calibrating the stamp. Returns the
 * paths of the traced hook and the no-op.
 *
 * The hook's lib/git-cmd.js requires `../../gsd-core/bin/lib/token-scanner.cjs`
 * relative to itself, so the copy sits at `<project>/hooks` with `<project>/gsd-core`
 * linked to the real one. Without that link the classifier fails to load and the
 * hook FAILS OPEN: a traced run would take a different path than the real one
 * (the parity test in tests/xtrace-phase-timing.test.cjs pins this).
 */
function prepareTracedHooks(project, ps4) {
  const dir = path.join(project, 'hooks');
  fs.cpSync(HOOKS_DIR, dir, { recursive: true });
  fs.symlinkSync(path.join(HOOKS_DIR, '..', 'gsd-core'), path.join(project, 'gsd-core'), 'dir');
  const hook = path.join(dir, HOOK_NAME);
  fs.writeFileSync(hook, injectTracing(fs.readFileSync(HOOK, 'utf8')));
  fs.writeFileSync(path.join(dir, TRACE_PS4_FILE), ps4);
  const noop = path.join(dir, 'noop.sh');
  const colons = Array.from({ length: CALIBRATION_COMMANDS }, () => ':').join('\n');
  fs.writeFileSync(noop, injectTracing(`#!/bin/bash\n${colons}\n`));
  return { hook, noop };
}

function hookEnv() {
  return {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`,
  };
}

/** bash with the options every call here shares; `options` overrides them. */
function spawnBash(args, options) {
  return spawnSync(BASH, args, { encoding: 'utf8', killSignal: 'SIGKILL', timeout: PROBE_BOUND_MS, ...options });
}

/**
 * Run the hook script at `script` on `command`. stdout is discarded and a
 * traced run's stderr goes to a FILE, never a pipe: the hook's node classifier
 * inherits both, and a grandchild that outlives the kill would otherwise hold
 * the pipe open and hang this process past its bound (the real test avoids that
 * with a process-group kill; spawnSync cannot).
 */
function runHook(project, command, script, traced) {
  const traceFile = path.join(project, 'trace.err');
  const traceFd = traced ? fs.openSync(traceFile, 'w') : null;
  const started = process.hrtime.bigint();
  let r;
  try {
    r = spawnBash([script], {
      cwd: project,
      env: hookEnv(),
      input: JSON.stringify({ tool_input: { command } }),
      stdio: ['pipe', 'ignore', traceFd === null ? 'ignore' : traceFd],
      timeout: HOOK_BOUND_MS,
    });
  } finally {
    if (traceFd !== null) fs.closeSync(traceFd);
  }
  const wallMs = Number((process.hrtime.bigint() - started) / 1000000n);
  let trace = '';
  let error = r.error ? r.error.code || r.error.message : null;
  if (traced) {
    if (fs.statSync(traceFile).size > MAX_TRACE_BYTES) error = error || 'trace exceeds the size cap';
    else trace = fs.readFileSync(traceFile, 'utf8');
  }
  return { wallMs, status: r.status, signal: r.signal, error, trace };
}

/** Cost of one stamp: a run of no-op commands under the same PS4. */
function calibrateStampMs(noop, nonce) {
  const r = spawnBash([noop], { env: hookEnv() });
  const { totalMs } = phaseCosts(parseTimedXtrace(r.stderr || '', nonce));
  return totalMs / CALIBRATION_COMMANDS;
}

function median(sorted) {
  return sorted[Math.floor(sorted.length / 2)];
}

/** Processes that keep forking node, like a tier of subprocess-spawning test files. */
function startLoad(count) {
  const churn =
    "const {spawnSync}=require('node:child_process');" +
    `const end=Date.now()+${LOAD_LIFETIME_MS};` +
    "while(Date.now()<end){spawnSync(process.execPath,['-e','0'],{stdio:'ignore'});}";
  return Array.from({ length: count }, () => spawn(process.execPath, ['-e', churn], { stdio: 'ignore' }));
}

function stopLoad(children) {
  for (const child of children) child.kill('SIGKILL');
}

function bashVersionLine() {
  return (spawnBash(['--version']).stdout || 'unknown').split('\n')[0];
}

/** Escape a value for a markdown table cell: backslash first, then the pipe. */
const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** Where a cost row points: the hook line and its source, or the function. */
function whereCell(c, source) {
  if (c.fn) return { line: `${c.fn}():${c.line}`, text: '(line may be function-relative)' };
  return { line: String(c.line), text: abbreviate(source[c.line - 1] || '', 70) };
}

/** Run one scenario untraced (repeated) and traced; no formatting. */
function measureScenario(project, scenario, hooks, nonce) {
  const walls = [];
  let last = null;
  for (let i = 0; i < UNTRACED_RUNS; i++) {
    last = runHook(project, scenario.command, HOOK, false);
    walls.push(last.wallMs);
  }
  walls.sort((a, b) => a - b);
  const traced = runHook(project, scenario.command, hooks.hook, true);
  const entries = shiftLines(parseTimedXtrace(traced.trace, nonce), INJECTED_LINES);
  const { costs, totalMs } = phaseCosts(entries);
  return { scenario, walls, last, traced, entries: entries.length, costs, totalMs };
}

function renderScenario(m, source, opts) {
  const { scenario, walls, last, traced } = m;
  const out = [`## ${scenario.name}`, ''];
  out.push(
    `untraced wall ms (${UNTRACED_RUNS} runs): min ${walls[0]} / median ${median(walls)} / max ${walls[walls.length - 1]}` +
    ` (last exit ${last.status}${last.signal ? `, ${last.signal}` : ''}${last.error ? `, ${last.error}` : ''}); ` +
    `traced span ${m.totalMs} ms over ${m.entries} commands${traced.signal ? ` (${traced.signal})` : ''}${traced.error ? ` (${traced.error})` : ''}; ` +
    `command ${scenario.command.length} bytes`,
    '',
  );
  if (m.entries === 0) {
    out.push('**TRACE EMPTY** — no stamped commands were parsed; the numbers below do not exist.', '');
    return out;
  }
  out.push(`Elapsed per ${REGION_LINES}-line region of the hook (ms):`, '');
  out.push('| region | ms |', '|---|---:|');
  for (const r of rollupByRegion(m.costs, REGION_LINES)) out.push(`| ${r.label} | ${r.afterMs} |`);
  out.push('');
  out.push('Slowest lines. `after` = gap following the line (slow EXECUTION); `before` = gap preceding it (slow EXPANSION):', '');
  out.push('| hook line | after ms | before ms | runs | source | traced value |');
  out.push('|---:|---:|---:|---:|---|---|');
  for (const c of slowestLines(m.costs, opts.top)) {
    const where = whereCell(c, source);
    out.push(`| ${cell(where.line)} | ${c.afterMs} | ${c.beforeMs} | ${c.count} | \`${cell(where.text)}\` | \`${cell(abbreviate(c.sample, 60))}\` |`);
  }
  out.push('');
  return out;
}

/**
 * The full report. `scenarioList` is injectable so the tests can drive the
 * whole pipeline on a cheap command; the CLI uses the three #4492 rows.
 *
 * @returns {{ text: string, ok: boolean }} ok is false if any scenario's trace was empty.
 */
function report(opts, scenarioList = scenarios()) {
  const project = makeProject();
  const source = fs.readFileSync(HOOK, 'utf8').split('\n');
  const nonce = crypto.randomBytes(6).toString('hex');
  const hooks = prepareTracedHooks(project, stampPs4(STAMP_COMMAND, nonce));
  const versionLine = bashVersionLine();
  const out = ['# validate-commit phase timing (#5473)', ''];
  out.push(`- shell: \`${BASH}\` (${versionLine})`);
  if (!/version 3\.2/.test(versionLine)) {
    out.push('- **WARNING: this is not bash 3.2, the shell the macOS failure occurs under; numbers do not reproduce it.**');
  }
  out.push(`- platform: ${process.platform}/${process.arch}, ${os.cpus().length} cpus, node ${process.version}`);
  out.push(`- background load: ${opts.load} process(es) forking node`);
  out.push(`- stamp overhead: ${calibrateStampMs(hooks.noop, nonce).toFixed(1)} ms per traced command (measured over ${CALIBRATION_COMMANDS} no-ops)`);
  out.push('- traced numbers rank lines; they are not comparable to untraced wall time (every command pays a stamp and xtrace prints each 112KB expansion)', '');
  const load = startLoad(opts.load);
  const measured = [];
  try {
    for (const scenario of scenarioList) measured.push(measureScenario(project, scenario, hooks, nonce));
  } finally {
    stopLoad(load);
    fs.rmSync(project, { recursive: true, force: true });
  }
  if (measured.length >= 2) {
    const first = measured[0];
    const last = measured[measured.length - 1];
    const ratio = median(last.walls) > 0 ? (median(first.walls) / median(last.walls)).toFixed(1) : 'n/a';
    out.push(`- untraced median: "${first.scenario.name}" ${median(first.walls)} ms vs "${last.scenario.name}" ${median(last.walls)} ms (ratio ${ratio}x)`, '');
  }
  for (const m of measured) out.push(...renderScenario(m, source, opts));
  return { text: out.join('\n'), ok: measured.every((m) => m.entries > 0) };
}

function run(argv = process.argv.slice(2)) {
  if (process.platform === 'win32') {
    throw new ExitError(2, 'diagnose-validate-commit-phases: needs a unix /bin/bash (macOS or Linux)');
  }
  if (!fs.existsSync(BASH)) {
    throw new ExitError(2, `diagnose-validate-commit-phases: ${BASH} not found`);
  }
  const { text, ok } = report(parseArgs(argv));
  process.stdout.write(`${text}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${text}\n`);
  return ok ? 0 : 1;
}

module.exports = {
  scenarios,
  parseArgs,
  whereCell,
  renderScenario,
  report,
  prepareTracedHooks,
  MAX_LOAD,
  STAMP_COMMAND,
  HOOKS_DIR,
  HOOK,
  HOOK_NAME,
};

if (require.main === module) runMain(run);
