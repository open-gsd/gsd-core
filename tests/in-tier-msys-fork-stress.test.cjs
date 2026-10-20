// Temporary in-tier measurement for #5473's Windows ETIMEDOUT reds; asserts no timing.

/**
 * Three bounded children hit their bound in ONE Windows conformance run (job
 * 39083981500): the #4784 `sh -c 'printf | sed | head -1'` at 10 s, an
 * `echo | grep | awk` bash pipeline at 5 s (nsegment-phase-grammar), and
 * `npm ls` through cmd.exe at 30 s. Each hit its bound EXACTLY, and the same
 * tier measures a bare `bash` start at ~35 ms warm with Defender real-time
 * protection off, so the stall is a hang, not slowness, and not launch cost.
 * What the first two share is a multi-process pipeline: Git Bash (MSYS2) has to
 * fork once per stage, and fork under load is the one thing a bare `sh -c true`
 * never does.
 *
 * One thing varies per phase, under the tier's own contention (WORKERS
 * concurrent chains, each spawning one child at a time, every child bounded):
 *   A  sh -c true                                        0 forks
 *   B  sh -c 'printf | sed | head -1'                    2 forks (the #4784 shape)
 *   C  sh -c 'printf | cat | cat | cat | cat | head -1'  5 forks
 * Every call over STALL_MS is listed with its phase, duration and offset, and
 * every call that hits the bound is counted. The report names no environment
 * variable or value.
 */

const { test } = require('node:test');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const WORKERS = 6;
const PHASE_MS = 30_000;
const CHILD_BOUND_MS = 10_000;
const STALL_MS = 2_000;

const PHASES = [
  ['A  sh -c true (0 forks)', 'true'],
  ['B  printf | sed | head -1 (2 forks, the #4784 shape)', "printf '%s\\n' x | sed -n 's/x/y/p' | head -1"],
  ['C  printf | cat | cat | cat | cat | head -1 (5 forks)', "printf '%s\\n' x | cat | cat | cat | cat | head -1"],
];

function runOne(script) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let timedOut = false;
    const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_BOUND_MS);
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolve({ ms: Number((process.hrtime.bigint() - started) / 1000000n), timedOut, error: true }); });
    child.on('close', () => { clearTimeout(timer); resolve({ ms: Number((process.hrtime.bigint() - started) / 1000000n), timedOut, error: false }); });
  });
}

async function runPhase(script) {
  const t0 = Date.now();
  const calls = [];
  const chain = async () => {
    while (Date.now() - t0 < PHASE_MS) {
      const r = await runOne(script);
      calls.push({ ...r, at: Date.now() - t0 });
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, chain));
  return calls;
}

function summarize(calls) {
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return `calls ${ms.length} / median ${at(0.5)} / p99 ${at(0.99)} / max ${ms[ms.length - 1]} / over ${STALL_MS}ms ${calls.filter((c) => c.ms > STALL_MS).length} / hit the ${CHILD_BOUND_MS}ms bound ${calls.filter((c) => c.timedOut).length} / spawn errors ${calls.filter((c) => c.error).length}`;
}

test('in-tier: sh pipelines under concurrency, by number of forks (win32 only; asserts nothing)', { skip: process.platform !== 'win32' && 'Windows-only' }, async () => {
  const lines = [
    '### MSYS fork stress inside the Windows conformance tier',
    '',
    `${WORKERS} concurrent chains per phase, ${PHASE_MS / 1000}s per phase, each child bounded at ${CHILD_BOUND_MS}ms; one thing varies per phase: the number of forks in the sh pipeline`,
    '',
  ];
  try {
    for (const [label, script] of PHASES) {
      const calls = await runPhase(script);
      lines.push(`**${label}**: ${summarize(calls)}`);
      const stalls = calls.filter((c) => c.ms > STALL_MS).sort((a, b) => b.ms - a.ms).slice(0, 12);
      for (const s of stalls) lines.push(`  - stall ${s.ms}ms at +${s.at}ms${s.timedOut ? ' (bound hit)' : ''}`);
      lines.push('');
    }
  } finally {
    const report = lines.join('\n');
    process.stdout.write(`\n${report}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`); } catch { /* summary is best effort */ }
    }
  }
});
