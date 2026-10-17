'use strict';

/**
 * #5473 — measure the 112KB hook rows INSIDE the real conformance tier.
 *
 * The standalone diagnostic (scripts/diagnose-validate-commit-phases.cjs, #5476)
 * found the hook costs ~0.2 s on a padded 112KB command on macos-latest under
 * /bin/bash 3.2, idle or with four node-forking processes beside it, and no
 * slower than an unpadded body. The conformance job's own row
 * (tests/hooks-opt-in.test.cjs) costs 2.5-5 s per invocation. So whatever makes
 * it slow is a property of how the row runs, not of the command. This module is
 * meant to be called from a test that the tier runs
 * (tests/in-tier-commit-hook-timing.test.cjs), so it sees exactly what the real
 * row sees: the node:test child's environment and the tier's contention.
 *
 * It varies one thing at a time on the same command and reports every cell:
 *
 *   - WHICH bash: the real row spawns `bash` by name (so whatever the PATH
 *     resolves, possibly a Homebrew bash 5), while the standalone diagnostic
 *     used /bin/bash 3.2. Both are timed, and both are named in the report;
 *   - the environment handed to the hook (inherited / minimal / without NODE_*
 *     / without GSD_* and RUN_TESTS_* / LC_ALL=C / LC_ALL=en_US.UTF-8: bash's
 *     pattern substitution is known to be slower in a multibyte locale);
 *   - how it is spawned (spawnSync, or asynchronous, detached and killed by
 *     process group, as the real row does). Every cell reads stdout and stderr
 *     through pipes, as the real row does, so spawn mode is the only difference.
 *
 * Runs are interleaved round-robin across the cells, rotating the starting
 * cell each round, so drift in the tier's load shows up as noise and not as a
 * variant effect. Then one traced run under the PATH bash. It asserts nothing
 * about time. The job environment carries tokens and the report goes to a
 * public log, so no variable name or value is read from the environment into
 * the report: it prints counts, which of a fixed list are set, and what
 * `locale` and `command -v bash` themselves say under that environment.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { stampPs4 } = require('./xtrace-phase-timing.cjs');
const cli = require('./diagnose-validate-commit-phases.cjs');

const SYSTEM_BASH = '/bin/bash';
const DEFAULT_RUNS = 2;
const VERSION_PROBE_BOUND_MS = 10000;

// Variables whose PRESENCE is worth reporting (a constant list: the report names
// these, never anything read from the environment).
const PRESENCE_ENV = [
  'CI', 'TEST_CONCURRENCY', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE',
  'GSD_PLUGIN_ROOT', 'GSD_STRICT_LIVE_CONFIG_GUARD', 'RUN_TESTS_TIMING_EVENTS_FILE',
];
const FAMILIES = ['NODE_', 'GSD_', 'RUN_TESTS_', 'LC_'];

/**
 * What the report may say about an environment: how many variables, how many in
 * each family, and which of PRESENCE_ENV are set. No name and no value is read
 * from the environment into the result, because the job environment carries
 * tokens and a report goes to a public log.
 */
function describeEnv(env) {
  const keys = Object.keys(env);
  const families = {};
  for (const prefix of FAMILIES) families[prefix] = keys.filter((k) => k.startsWith(prefix)).length;
  const present = PRESENCE_ENV.filter((name) => Object.hasOwn(env, name));
  return { count: keys.length, families, present };
}

/**
 * The effective locale the hook would see under `env`, as `locale` itself reports
 * it (LANG and LC_* lines only). Asking the tool, rather than reading the variables,
 * is also what tells a missing locale from a set one.
 */
function localeReport(env) {
  const r = spawnSync('locale', [], { env, encoding: 'utf8', timeout: VERSION_PROBE_BOUND_MS });
  if (r.error || r.status !== 0) return 'unavailable';
  return r.stdout.split('\n').filter((line) => /^(LANG|LC_[A-Z]+)=/.test(line)).join(' ');
}

/** `env` without any variable whose name starts with one of `prefixes`. */
function without(env, prefixes) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

/** The first executable named `name` on `pathVar`, as `spawn(name)` would resolve it, or null. */
function findOnPath(name, pathVar) {
  for (const dir of String(pathVar || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * The cells to time. `base` is the real row's environment; `bash` is what
 * `spawn('bash')` resolves to under it. A cell is one (interpreter, environment,
 * spawn mode); cells that would repeat another are left out.
 */
function buildCells(base, bash) {
  const cells = [];
  const add = (label, bin, env, mode) => cells.push({ label, bin, env, mode });
  add('PATH bash, inherited env', bash, base, 'sync');
  add('PATH bash, inherited env', bash, base, 'async');
  if (bash !== SYSTEM_BASH) {
    add('/bin/bash, inherited env', SYSTEM_BASH, base, 'sync');
    add('/bin/bash, inherited env', SYSTEM_BASH, base, 'async');
  }
  add('PATH bash, minimal env (PATH, HOME)', bash, { PATH: base.PATH, HOME: base.HOME || '' }, 'sync');
  add('PATH bash, without NODE_*', bash, without(base, ['NODE_']), 'sync');
  add('PATH bash, without GSD_* / RUN_TESTS_*', bash, without(base, ['GSD_', 'RUN_TESTS_']), 'sync');
  add('PATH bash, LC_ALL=C', bash, { ...base, LC_ALL: 'C' }, 'sync');
  add('PATH bash, LC_ALL=en_US.UTF-8', bash, { ...base, LC_ALL: 'en_US.UTF-8' }, 'sync');
  return cells;
}

const elapsedMs = (started) => Number((process.hrtime.bigint() - started) / 1000000n);

/** One synchronous run; stdout and stderr go through pipes like the real row's. */
function runSync(project, command, env, bin) {
  const started = process.hrtime.bigint();
  const r = spawnSync(bin, [cli.HOOK], {
    cwd: project,
    env,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    timeout: cli.HOOK_BOUND_MS,
    killSignal: 'SIGKILL',
  });
  return { wallMs: elapsedMs(started), status: r.status, signal: r.signal, killed: r.signal === 'SIGKILL' };
}

/**
 * One run the way the real row does it (tests/hooks-opt-in.test.cjs runCmdAsync):
 * asynchronous, detached, stdout and stderr read through pipes, killed by
 * process group at the bound.
 */
function runDetached(project, command, env, bin) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(bin, [cli.HOOK], { cwd: project, env, detached: true });
    let settled = false;
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, cli.HOOK_BOUND_MS);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ wallMs: elapsedMs(started), killed, ...result });
    };
    child.on('error', (err) => settle({ status: null, signal: null, error: err.code || err.message }));
    child.stdin.on('error', () => { /* the hook may exit before reading stdin */ });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('close', (status, signal) => settle({ status, signal }));
    child.stdin.end(JSON.stringify({ tool_input: { command } }));
  });
}

const summarize = (walls) => {
  const sorted = [...walls].sort((a, b) => a - b);
  return `min ${sorted[0]} / median ${cli.median(sorted)} / max ${sorted[sorted.length - 1]}`;
};

function versionLine(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: VERSION_PROBE_BOUND_MS });
  return (r.stdout || 'unknown').split('\n')[0];
}

/** The order to visit `count` cells in round `round`: every cell once, starting one further along each round. */
function roundOrder(count, round) {
  return Array.from({ length: count }, (_, k) => (k + round) % count);
}

/** Where the shell itself resolves `bash` under `env` (its answer is what the report prints). */
function resolveBash(env) {
  const r = spawnSync('/bin/sh', ['-c', 'command -v bash'], { env, encoding: 'utf8', timeout: VERSION_PROBE_BOUND_MS });
  return r.status === 0 ? r.stdout.trim() : 'not found';
}

/** Run every cell `runs` times, round-robin, rotating the starting cell each round. */
async function measureCells(project, command, cells, runs) {
  const walls = cells.map(() => []);
  const last = cells.map(() => null);
  for (let round = 0; round < runs; round++) {
    for (const i of roundOrder(cells.length, round)) {
      const cell = cells[i];
      const result = cell.mode === 'async'
        ? await runDetached(project, command, cell.env, cell.bin)
        : runSync(project, command, cell.env, cell.bin);
      walls[i].push(result.wallMs);
      last[i] = result;
    }
  }
  return cells.map((cell, i) => ({ cell, walls: walls[i], last: last[i] }));
}

/**
 * @param {{ runs?: number, scenarioList?: { name: string, command: string }[] }} [options]
 *   scenarioList defaults to the padded + trailing-option row and the unpadded comparison.
 * @returns {Promise<{ text: string, ok: boolean }>} ok is false if the traced run produced no trace.
 */
async function inTierReport({ runs = DEFAULT_RUNS, scenarioList } = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError('runs must be a positive integer');
  const all = cli.scenarios();
  const picked = scenarioList || [all[1], all[2]];
  const base = cli.hookEnv();
  const bash = findOnPath('bash', base.PATH) || SYSTEM_BASH;
  const cells = buildCells(base, bash);
  const nonce = crypto.randomBytes(6).toString('hex');
  const desc = describeEnv(process.env);
  const out = ['# validate-commit INSIDE the conformance tier (#5473)', ''];
  out.push(`- host: ${os.type()} ${os.release()} ${process.arch}, ${os.cpus().length} cpus, load average ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}, node ${process.version}`);
  out.push(`- \`bash\` on the inherited PATH: ${resolveBash(base)} (${versionLine(bash)})`);
  out.push(`- /bin/bash: ${versionLine(SYSTEM_BASH)}`);
  out.push(`- environment: ${desc.count} variables (${FAMILIES.map((p) => `${p}* ${desc.families[p]}`).join(', ')}); set: ${desc.present.join(' ') || 'none of the watched ones'}`);
  out.push(`- effective locale: ${localeReport(base)}`);
  out.push(`- ${runs} runs per cell, interleaved round-robin across cells with a rotating start`, '');
  let project;
  let traced;
  try {
    project = cli.makeProject();
    const hooks = cli.prepareTracedHooks(project, stampPs4(cli.STAMP_COMMAND, nonce));
    for (const scenario of picked) {
      out.push(`## ${scenario.name} (${scenario.command.length} bytes)`, '');
      out.push(`| interpreter, environment | spawn | wall ms (${runs} runs) | last exit |`, '|---|---|---|---|');
      for (const m of await measureCells(project, scenario.command, cells, runs)) {
        const mode = m.cell.mode === 'async' ? 'async + detached + group kill' : 'spawnSync';
        const exit = `${m.last.status}${m.last.signal ? ` ${m.last.signal}` : ''}${m.last.killed ? ' KILLED' : ''}`;
        out.push(`| ${m.cell.label} | ${mode} | ${summarize(m.walls)} | ${exit} |`);
      }
      out.push('');
    }
    traced = cli.measureScenario(project, picked[0], hooks, nonce, bash);
  } finally {
    if (project) fs.rmSync(project, { recursive: true, force: true });
  }
  out.push('## traced run under the inherited environment (PATH bash)', '');
  out.push(...cli.renderScenario(traced, fs.readFileSync(cli.HOOK, 'utf8').split('\n'), { top: 12 }));
  out.push(`- load average after: ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);
  return { text: out.join('\n'), ok: traced.entries > 0 };
}

module.exports = {
  describeEnv,
  localeReport,
  without,
  findOnPath,
  buildCells,
  roundOrder,
  runSync,
  runDetached,
  measureCells,
  inTierReport,
  PRESENCE_ENV,
  FAMILIES,
  SYSTEM_BASH,
};
