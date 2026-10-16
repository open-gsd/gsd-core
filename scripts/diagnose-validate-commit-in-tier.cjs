'use strict';

/**
 * #5473 — measure the 112KB hook rows INSIDE the real conformance tier.
 *
 * The standalone diagnostic (scripts/diagnose-validate-commit-phases.cjs, #5476)
 * found the hook costs ~0.2 s on a padded 112KB command on macos-latest, idle
 * or with four node-forking processes beside it, and no slower than an unpadded
 * body. The conformance job's own row (tests/hooks-opt-in.test.cjs) costs
 * 2.5-5 s per invocation. So whatever makes it slow is a property of running
 * INSIDE the tier, not of the command. This module is meant to be called from
 * a test that the tier runs (tests/validate-commit-in-tier-timing.test.cjs), so
 * it sees exactly what the real row sees: the node:test child's environment and
 * the tier's contention. It varies one thing at a time on the same command:
 *
 *   - the environment handed to the hook (inherited / minimal / without the
 *     NODE_* variables / without the GSD_* and RUN_TESTS_* variables);
 *   - how the hook is spawned (synchronously, or asynchronously and detached
 *     with a process-group kill, as the real row does).
 *
 * and then takes one traced run under the inherited environment. It asserts
 * nothing about time. Environment VALUES are never printed except for a short
 * allowlist; everything else is reported by name only (the job environment
 * carries tokens).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { stampPs4 } = require('./xtrace-phase-timing.cjs');
const cli = require('./diagnose-validate-commit-phases.cjs');

const BASH = '/bin/bash';
const RUNS_PER_CELL = 3;
const DETACHED_BOUND_MS = 30000;

// Variables whose VALUE is safe and useful to show. Anything else: name only.
const SHOWN_ENV = [
  'CI', 'RUNNER_OS', 'RUNNER_ARCH', 'TMPDIR', 'TEST_CONCURRENCY',
  'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE',
  'GSD_PLUGIN_ROOT', 'GSD_STRICT_LIVE_CONFIG_GUARD', 'RUN_TESTS_TIMING_EVENTS_FILE',
];

/** Names of every variable (sorted) plus the values of the allowlisted ones. */
function describeEnv(env) {
  const names = Object.keys(env).sort();
  const shown = {};
  for (const key of SHOWN_ENV) if (Object.hasOwn(env, key)) shown[key] = env[key];
  return { names, shown };
}

/** `env` without any variable whose name starts with one of `prefixes`. */
function without(env, prefixes) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

/** The environments to compare, each derived from `base` (the real test's). */
function envVariants(base) {
  return [
    { name: 'inherited (what the real row passes)', env: base },
    { name: 'minimal (PATH, HOME)', env: { PATH: base.PATH, HOME: base.HOME || '' } },
    { name: 'inherited without NODE_*', env: without(base, ['NODE_']) },
    { name: 'inherited without GSD_* / RUN_TESTS_*', env: without(base, ['GSD_', 'RUN_TESTS_']) },
  ];
}

/**
 * Spawn the hook the way the real row does (tests/hooks-opt-in.test.cjs
 * runCmdAsync): asynchronous, detached, killed by process group at the bound.
 */
function runDetached(project, command, env) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(BASH, [cli.HOOK], { cwd: project, env, detached: true });
    let settled = false;
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, DETACHED_BOUND_MS);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ wallMs: Number((process.hrtime.bigint() - started) / 1000000n), killed, ...result });
    };
    child.on('error', (err) => settle({ status: null, error: err.code || err.message }));
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

/**
 * @returns {Promise<{ text: string, ok: boolean }>} ok is false if the traced run produced no trace.
 */
async function inTierReport({ runs = RUNS_PER_CELL, scenarioList = cli.scenarios() } = {}) {
  const project = cli.makeProject();
  const nonce = crypto.randomBytes(6).toString('hex');
  const hooks = cli.prepareTracedHooks(project, stampPs4(cli.STAMP_COMMAND, nonce));
  const base = cli.hookEnv();
  const variants = envVariants(base);
  const out = ['# validate-commit INSIDE the conformance tier (#5473)', ''];
  const desc = describeEnv(process.env);
  out.push(`- host: ${os.type()} ${os.release()} ${process.arch}, ${os.cpus().length} cpus, load average ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}, node ${process.version}`);
  out.push(`- environment: ${desc.names.length} variables`);
  out.push(`- shown values: ${JSON.stringify(desc.shown)}`);
  out.push(`- variable names: ${desc.names.join(' ')}`, '');
  const picked = [scenarioList[0], scenarioList[scenarioList.length - 1]];
  let traced;
  try {
    for (const scenario of picked) {
      out.push(`## ${scenario.name} (${scenario.command.length} bytes)`, '');
      out.push('| environment | spawn | wall ms (' + runs + ' runs) | exit |', '|---|---|---|---|');
      for (const variant of variants) {
        const walls = [];
        let last;
        for (let i = 0; i < runs; i++) {
          last = cli.runHook(project, scenario.command, cli.HOOK, false, variant.env);
          walls.push(last.wallMs);
        }
        out.push(`| ${variant.name} | spawnSync | ${summarize(walls)} | ${last.status}${last.signal ? ` ${last.signal}` : ''} |`);
      }
      const dwalls = [];
      let dlast;
      for (let i = 0; i < runs; i++) {
        dlast = await runDetached(project, scenario.command, base);
        dwalls.push(dlast.wallMs);
      }
      out.push(`| inherited (what the real row passes) | async + detached + group kill | ${summarize(dwalls)} | ${dlast.status}${dlast.killed ? ' KILLED' : ''} |`);
      out.push('');
    }
    traced = cli.measureScenario(project, picked[0], hooks, nonce);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
  out.push('## traced run under the inherited environment', '');
  out.push(...cli.renderScenario(traced, fs.readFileSync(cli.HOOK, 'utf8').split('\n'), { top: 12 }));
  out.push(`- load average after: ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);
  return { text: out.join('\n'), ok: traced.entries > 0 };
}

module.exports = { describeEnv, without, envVariants, runDetached, inTierReport, SHOWN_ENV };
