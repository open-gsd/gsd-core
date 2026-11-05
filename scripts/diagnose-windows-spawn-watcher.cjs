'use strict';

/**
 * #5473 — a job-long watcher for the Windows conformance tier's bounded-child stalls.
 *
 * In one Windows run (job 39083981500) three different tests each hit their
 * bound EXACTLY: the #4784 `sh -c 'printf | sed | head -1'` at 10 s, an
 * `echo | grep | awk` bash pipeline at 5 s, and `npm ls` through cmd.exe at 30 s.
 * Measured inside the tier, a bare `bash` starts in ~35 ms, Defender real-time
 * protection is off, and 2,407 pipeline calls under 6-way concurrency never
 * stalled past 2 s. So the stall is rare and does not reproduce on demand. This
 * watcher runs beside the whole test step on the same VM and writes down, with a
 * UTC wall-clock timestamp, every moment the VM itself stops making progress:
 *
 *   - `loop-gap`: this process's own timer fired more than LOOP_GAP_MS late
 *     (the whole VM, or at least this process, was not scheduled);
 *   - `probe-slow`: a probe child (the #4784 sh pipeline, or `cmd /c exit`)
 *     took more than PROBE_SLOW_MS, or hit its bound;
 *   - `procs`: a snapshot of the live node/sh/bash/cmd/npm/git processes (name,
 *     parent, age, CPU time so far, and the *.test.cjs names in their
 *     arguments), taken after either anomaly and every two minutes, so a stall
 *     can be lined up with what else was running in the chunk. Earlier red
 *     `next`s (see defaultMaxUnmeasuredPerChunk in scripts/run-tests.cjs) lost
 *     whole chunks at 600000 ms with zero failing tests; the periodic snapshots
 *     show which test file a killed chunk was inside and whether it was idle.
 *
 * Timestamps are ISO UTC, the same clock as the lines in the job log, so a
 * failing test's end time minus its duration can be lined up against these
 * events: a stall that is the VM freezing shows up here at the same instant; a
 * stall that is only that one child hanging does not.
 *
 *   node scripts/diagnose-windows-spawn-watcher.cjs start [dir]   spawn detached, return at once
 *   node scripts/diagnose-windows-spawn-watcher.cjs report [dir]  stop it, print and summarize the events
 *
 * `dir` defaults to RUNNER_TEMP/spawn-watcher. No environment variable or value
 * is read into the report. TEMPORARY: delete
 * with scripts/diagnose-validate-commit-*.cjs once #5473 is resolved.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const TICK_MS = 250;
const LOOP_GAP_MS = 750;
// The watcher must not become the load it is looking for: a stall that shows up once in
// thousands of calls is easy to shift with extra spawn churn, so probes are sparse (one
// sh and one cmd every 5 s, about 480 pairs over a 40 minute job) and the CIM query,
// the heavy part, runs every 5 minutes plus at most once a minute after an anomaly.
const PROBE_EVERY_MS = 5000;
const PROBE_BOUND_MS = 15_000;
const PROBE_SLOW_MS = 1500;
const MAX_LIFETIME_MS = 40 * 60_000;
const PIPELINE = "printf '%s\\n' x | sed -n 's/x/y/p' | head -1";

const REPORT_WAIT_MS = 20_000;
const EVENTS_FILE = 'events.log';
const STOP_FILE = 'stop';
const SUMMARY_FILE = 'summary.json';

/** One event line: `<ISO UTC> <kind> <ms> <detail>`. */
function formatEvent(at, kind, ms, detail) {
  return `${new Date(at).toISOString()} ${kind} ${ms} ${detail}`;
}

const SHELL_NAMES = new Set(['sh', 'bash', 'cmd']);
const LINGER_AGE_S = 30;

/**
 * One compact line for a process snapshot. `rows` are `{pid, ppid, name, born, cpuMs, cmd}`
 * (born = epoch ms, cmd = the command line). Only what identifies the work is kept: the
 * process name, its age, its CPU time so far, and the `*.test.cjs` file names in its
 * arguments (the node:test chunk children carry them). Nothing else from a command line
 * is reported, because the job environment carries tokens and a report is public.
 */
function formatProcs(rows, now) {
  return rows
    .map((r) => {
      const tests = [...new Set(String(r.cmd || '').match(/[\w.-]+\.test\.cjs/g) || [])].slice(0, 3);
      const age = Math.max(0, Math.round((now - r.born) / 1000));
      const cpu = Math.round(r.cpuMs / 1000);
      // A shell that outlives every bound the tests set is the signature of a descendant
      // still holding a spawnSync stdio pipe: node's timer then reports ETIMEDOUT at the
      // exact bound although the direct child already exited (node src/spawn_sync.cc).
      const lingering = SHELL_NAMES.has(r.name) && age > LINGER_AGE_S ? ' LINGERING' : '';
      return `${r.name}#${r.pid}<${r.ppid} age ${age}s cpu ${cpu}s${lingering}${tests.length ? ` [${tests.join(' ')}]` : ''}`;
    })
    .join(' | ');
}

/** Inverse of formatEvent; null for a line that is not an event. */
function parseEvent(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (loop-gap|probe-slow|probe-error|procs) (\d+) (.*)$/.exec(line);
  if (!m) return null;
  return { at: m[1], kind: m[2], ms: Number(m[3]), detail: m[4] };
}

/** Counts and extremes per kind, over parsed events. */
function summarizeEvents(events) {
  const out = {};
  for (const e of events) {
    const s = out[e.kind] || (out[e.kind] = { count: 0, maxMs: 0 });
    s.count += 1;
    if (e.ms > s.maxMs) s.maxMs = e.ms;
  }
  return out;
}

/** Percentile (0..1) of numbers, nearest-rank on a sorted copy; null when empty. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Run one probe child. `onDone(label, ms, timedOut, started, error)`: `error` is the spawn
 * error code (or the thrown message) when the probe never ran, else null. A probe that
 * never ran must not look like a fast success, so callers keep it out of the latencies.
 */
function probe(label, bin, args, onDone) {
  const started = Date.now();
  let timedOut = false;
  let settled = false;
  let timer = null;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onDone(label, Date.now() - started, timedOut, started, error || null);
  };
  let child;
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    finish(`threw ${e && e.code ? e.code : 'error'}`);
    return;
  }
  timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } finish(); }, PROBE_BOUND_MS);
  child.stdout.resume();
  child.stderr.resume();
  child.on('error', (e) => finish(`spawn ${e && e.code ? e.code : 'error'}`));
  child.on('close', () => finish());
}

const PS_PROCS = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|sh|bash|cmd|npm|git)\\.exe$' } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name -replace '\\.exe$', ''; born = [int64](([datetime]$_.CreationDate).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds; cpuMs = [int64](($_.KernelModeTime + $_.UserModeTime) / 10000); cmd = $_.CommandLine } } | ConvertTo-Json -Compress";
const SNAPSHOT_EVERY_MS = 300_000;
const SNAPSHOT_COOLDOWN_MS = 60_000;
const SNAPSHOT_BOUND_MS = 30_000;

/** Snapshot the live node/sh/bash/cmd/npm/git processes; calls back with the compact line. */
function snapshotProcs(onDone) {
  const started = Date.now();
  let out = '';
  let err = '';
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_PROCS], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    onDone(Date.now() - started, `snapshot unavailable (threw ${e && e.code ? e.code : 'error'})`);
    return;
  }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, SNAPSHOT_BOUND_MS);
  child.stdout.on('data', (d) => { out += d; });
  // PowerShell's own error text carries no command lines; a short head tells a failure from a timeout.
  child.stderr.on('data', (d) => { if (err.length < 200) err += d; });
  child.on('error', (e) => { clearTimeout(timer); onDone(Date.now() - started, `snapshot unavailable (spawn ${e && e.code ? e.code : 'error'})`); });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    let rows = [];
    try { const parsed = JSON.parse(out); rows = Array.isArray(parsed) ? parsed : [parsed]; } catch { /* no rows */ }
    // The watcher's own process and its probe/snapshot children are not what we are lining up against.
    rows = rows.filter((r) => r.pid !== process.pid && r.ppid !== process.pid);
    const why = signal ? `killed ${signal}` : `exit ${code}`;
    onDone(
      Date.now() - started,
      rows.length ? `${rows.length} procs: ${formatProcs(rows, Date.now())}` : `snapshot unavailable (${why}${err ? `: ${err.replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''})`,
    );
  });
}

function run(dir) {
  const eventsPath = path.join(dir, EVENTS_FILE);
  const record = (at, kind, ms, detail) => {
    try { fs.appendFileSync(eventsPath, `${formatEvent(at, kind, ms, detail)}\n`); } catch { /* dir gone: nothing to do */ }
  };
  let lastSnapshotAt = 0;
  let snapshotting = false;
  const takeSnapshot = (why) => {
    const now = Date.now();
    if (snapshotting || now - lastSnapshotAt < SNAPSHOT_COOLDOWN_MS) return;
    snapshotting = true;
    lastSnapshotAt = now;
    snapshotProcs((ms, detail) => { snapshotting = false; record(Date.now(), 'procs', ms, `${why}: ${detail}`); });
  };
  const snapshotTimer = setInterval(() => takeSnapshot('periodic'), SNAPSHOT_EVERY_MS);
  const lifetimeEnd = Date.now() + MAX_LIFETIME_MS;
  const probeMs = { sh: [], cmd: [] };
  let probeCount = 0;
  let last = Date.now();

  const tick = setInterval(() => {
    const now = Date.now();
    const late = now - last - TICK_MS;
    if (late > LOOP_GAP_MS) { record(now, 'loop-gap', late, `timer fired ${late}ms late`); takeSnapshot('after loop-gap'); }
    last = now;
    if (now > lifetimeEnd || fs.existsSync(path.join(dir, STOP_FILE))) finishRun();
  }, TICK_MS);

  const probeErrors = { sh: 0, cmd: 0 };
  const onProbe = (label, ms, timedOut, started, error) => {
    if (error) {
      probeErrors[label] += 1;
      record(Date.now(), 'probe-error', ms, `${label} never ran: ${error}`);
      return;
    }
    probeCount += 1;
    probeMs[label].push(ms);
    if (ms > PROBE_SLOW_MS || timedOut) {
      record(Date.now(), 'probe-slow', ms, `${label} started ${new Date(started).toISOString()}${timedOut ? ' hit the bound' : ''}`);
      takeSnapshot('after probe-slow');
    }
  };

  let probing = true;
  let loopTimer = null;
  // Run the two probes one after the other, then wait out the rest of the interval.
  const loop = () => {
    if (!probing) return;
    const cycleStart = Date.now();
    probe('sh', 'sh', ['-c', PIPELINE], (l, ms, to, st, er) => {
      onProbe(l, ms, to, st, er);
      probe('cmd', 'cmd', ['/c', 'exit', '0'], (l2, ms2, to2, st2, er2) => {
        onProbe(l2, ms2, to2, st2, er2);
        loopTimer = setTimeout(loop, Math.max(0, PROBE_EVERY_MS - (Date.now() - cycleStart)));
      });
    });
  };
  loop();

  function finishRun() {
    probing = false;
    clearInterval(tick);
    clearInterval(snapshotTimer);
    clearTimeout(loopTimer);
    const summary = {
      probes: probeCount,
      sh: { n: probeMs.sh.length, errors: probeErrors.sh, median: percentile(probeMs.sh, 0.5), p99: percentile(probeMs.sh, 0.99), max: percentile(probeMs.sh, 1) },
      cmd: { n: probeMs.cmd.length, errors: probeErrors.cmd, median: percentile(probeMs.cmd, 0.5), p99: percentile(probeMs.cmd, 0.99), max: percentile(probeMs.cmd, 1) },
    };
    // Write then rename, so report never sees the file before its content has landed.
    try {
      const target = path.join(dir, SUMMARY_FILE);
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(summary));
      fs.renameSync(`${target}.tmp`, target);
    } catch { /* best effort */ }
    // No process.exit (ADR-3889): every timer is cleared above, so the process ends when the
    // probe or snapshot child still in flight (each bounded) has exited; report has already
    // been released by the summary file, so nothing waits on this.
  }
}

function start(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [__filename, 'run', dir], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function report(dir) {
  try { fs.writeFileSync(path.join(dir, STOP_FILE), ''); } catch { /* start never ran */ }
  // The stop file is only seen on the watcher's 250ms tick, so a VM stall longer than this
  // wait (the very case under study) leaves no summary: say so below instead of "crashed".
  const deadline = Date.now() + REPORT_WAIT_MS;
  while (!fs.existsSync(path.join(dir, SUMMARY_FILE)) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  let events = [];
  try {
    events = fs.readFileSync(path.join(dir, EVENTS_FILE), 'utf8').split('\n').map(parseEvent).filter(Boolean);
  } catch { /* no events file: nothing recorded */ }
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(dir, SUMMARY_FILE), 'utf8')); } catch { /* watcher did not finish */ }
  const lines = [
    '### #5473 Windows spawn-stall watcher (whole test step, same VM)',
    '',
    summary
      ? `probes: ${summary.probes} ; sh pipeline median ${summary.sh.median} / p99 ${summary.sh.p99} / max ${summary.sh.max} ms (n=${summary.sh.n}, never ran ${summary.sh.errors}) ; cmd /c exit median ${summary.cmd.median} / p99 ${summary.cmd.p99} / max ${summary.cmd.max} ms (n=${summary.cmd.n}, never ran ${summary.cmd.errors})`
      : `watcher summary missing after ${REPORT_WAIT_MS / 1000}s: it either crashed or was stalled past the wait (the events below show which: a stall leaves loop-gap/probe-slow lines up to the last tick)`,
    `events: ${JSON.stringify(summarizeEvents(events))}`,
    '',
    ...events.map((e) => `- ${e.at} ${e.kind} ${e.ms}ms ${e.detail}`),
  ];
  const text = lines.join('\n');
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); } catch { /* best effort */ }
  }
}

// CONTRIBUTING forbids `${{ }}` inside a workflow `run:` block, so the workflow
// passes no directory: GitHub sets RUNNER_TEMP itself, and start and report agree on it here.
function defaultDir() {
  return path.join(process.env.RUNNER_TEMP || require('node:os').tmpdir(), 'spawn-watcher');
}

function main() {
  const [, , mode, dirArg] = process.argv;
  if (!['start', 'run', 'report'].includes(mode)) {
    throw new ExitError(2, 'usage: diagnose-windows-spawn-watcher.cjs start|report [dir]');
  }
  ({ start, run, report })[mode](path.resolve(dirArg || defaultDir()));
}

if (require.main === module) runMain(main);

module.exports = { formatEvent, formatProcs, parseEvent, summarizeEvents, percentile, LOOP_GAP_MS, PROBE_SLOW_MS };
