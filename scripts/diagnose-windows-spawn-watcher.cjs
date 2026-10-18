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
 *     took more than PROBE_SLOW_MS, or hit its bound.
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

const TICK_MS = 250;
const LOOP_GAP_MS = 750;
const PROBE_EVERY_MS = 2000;
const PROBE_BOUND_MS = 15_000;
const PROBE_SLOW_MS = 1500;
const MAX_LIFETIME_MS = 40 * 60_000;
const PIPELINE = "printf '%s\\n' x | sed -n 's/x/y/p' | head -1";

const EVENTS_FILE = 'events.log';
const STOP_FILE = 'stop';
const SUMMARY_FILE = 'summary.json';

/** One event line: `<ISO UTC> <kind> <ms> <detail>`. */
function formatEvent(at, kind, ms, detail) {
  return `${new Date(at).toISOString()} ${kind} ${ms} ${detail}`;
}

/** Inverse of formatEvent; null for a line that is not an event. */
function parseEvent(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (loop-gap|probe-slow) (\d+) (.*)$/.exec(line);
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

function probe(label, bin, args, onDone) {
  const started = Date.now();
  let timedOut = false;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onDone(label, Date.now() - started, timedOut, started);
  };
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } finish(); }, PROBE_BOUND_MS);
  child.stdout.resume();
  child.stderr.resume();
  child.on('error', finish);
  child.on('close', finish);
}

function run(dir) {
  const eventsPath = path.join(dir, EVENTS_FILE);
  const record = (at, kind, ms, detail) => {
    try { fs.appendFileSync(eventsPath, `${formatEvent(at, kind, ms, detail)}\n`); } catch { /* dir gone: nothing to do */ }
  };
  const lifetimeEnd = Date.now() + MAX_LIFETIME_MS;
  const probeMs = { sh: [], cmd: [] };
  let probeCount = 0;
  let last = Date.now();

  const tick = setInterval(() => {
    const now = Date.now();
    const late = now - last - TICK_MS;
    if (late > LOOP_GAP_MS) record(now, 'loop-gap', late, `timer fired ${late}ms late`);
    last = now;
    if (now > lifetimeEnd || fs.existsSync(path.join(dir, STOP_FILE))) finishRun();
  }, TICK_MS);

  const onProbe = (label, ms, timedOut, started) => {
    probeCount += 1;
    probeMs[label].push(ms);
    if (ms > PROBE_SLOW_MS || timedOut) {
      record(Date.now(), 'probe-slow', ms, `${label} started ${new Date(started).toISOString()}${timedOut ? ' hit the bound' : ''}`);
    }
  };

  let probing = true;
  // Run the two probes one after the other, then wait out the rest of the interval.
  const loop = () => {
    if (!probing) return;
    const cycleStart = Date.now();
    probe('sh', 'sh', ['-c', PIPELINE], (l, ms, to, st) => {
      onProbe(l, ms, to, st);
      probe('cmd', 'cmd', ['/c', 'exit', '0'], (l2, ms2, to2, st2) => {
        onProbe(l2, ms2, to2, st2);
        setTimeout(loop, Math.max(0, PROBE_EVERY_MS - (Date.now() - cycleStart)));
      });
    });
  };
  loop();

  function finishRun() {
    probing = false;
    clearInterval(tick);
    const summary = {
      probes: probeCount,
      sh: { n: probeMs.sh.length, median: percentile(probeMs.sh, 0.5), p99: percentile(probeMs.sh, 0.99), max: percentile(probeMs.sh, 1) },
      cmd: { n: probeMs.cmd.length, median: percentile(probeMs.cmd, 0.5), p99: percentile(probeMs.cmd, 0.99), max: percentile(probeMs.cmd, 1) },
    };
    try { fs.writeFileSync(path.join(dir, SUMMARY_FILE), JSON.stringify(summary)); } catch { /* best effort */ }
    process.exit(0);
  }
}

function start(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [__filename, 'run', dir], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function report(dir) {
  try { fs.writeFileSync(path.join(dir, STOP_FILE), ''); } catch { /* start never ran */ }
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, SUMMARY_FILE)) && Date.now() < deadline) {
    const until = Date.now() + 100;
    while (Date.now() < until) { /* short busy wait: the watcher needs <1s to flush */ }
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
      ? `probes: ${summary.probes} ; sh pipeline median ${summary.sh.median} / p99 ${summary.sh.p99} / max ${summary.sh.max} ms (n=${summary.sh.n}) ; cmd /c exit median ${summary.cmd.median} / p99 ${summary.cmd.p99} / max ${summary.cmd.max} ms (n=${summary.cmd.n})`
      : 'watcher summary missing: it did not run to a clean stop',
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

if (require.main === module) {
  const [, , mode, dirArg] = process.argv;
  if (!['start', 'run', 'report'].includes(mode)) {
    process.stderr.write('usage: diagnose-windows-spawn-watcher.cjs start|report [dir]\n');
    process.exit(2);
  }
  ({ start, run, report })[mode](path.resolve(dirArg || defaultDir()));
}

module.exports = { formatEvent, parseEvent, summarizeEvents, percentile, LOOP_GAP_MS, PROBE_SLOW_MS };
