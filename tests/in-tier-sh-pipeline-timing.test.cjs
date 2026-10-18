// Temporary in-tier measurement for #5473's Windows test-gate-watch-mode ETIMEDOUT; asserts no timing.

/**
 * Measure, INSIDE the Windows conformance tier, what the #4784 test in
 * tests/test-gate-watch-mode.test.cjs spends its time on: one `sh -c
 * 'printf | sed | head -1'` (run 38984013970 timed out after 10 s on
 * windows-latest where the whole file normally takes ~0.6 s, while every other
 * test file in the same run was within ~1 s of its usual time).
 *
 * One thing varies per cell, on the same fixture line the real test uses:
 *   - the real pipeline through `sh`;
 *   - `sh -c true` (interpreter start only);
 *   - printf | sed (no `head`);
 *   - `sed` spawned directly with the line on stdin (no sh, no pipe);
 *   - `sh` named by absolute path vs resolved from PATH;
 *   - the real pipeline with a minimal environment;
 *   - `node -e 0` and `cmd /c exit` (process-creation baselines).
 * Runs are round-robin with a rotating start, and EVERY run is printed in
 * order so a cold first execution shows up as a first-run outlier rather than
 * being averaged away. The report names no environment variable or value.
 *
 * Second test (cold `bash` launch vs temp drive and Defender): the 2026-10-17
 * failure on `next` (run 39078837680, shard 2/3) was `spawnSync bash ETIMEDOUT`
 * on the FIRST bash start in tests/nsegment-phase-grammar.test.cjs: 8,443 ms
 * against a 5,000 ms bound, while the next two identical spawns took ~0.4-0.6 s.
 * On this runner the checkout is on D: but TEMP/TMP and Git for Windows are on
 * C:. It times the same `bash` start (script on stdin, as that test does) with
 * the default TEMP/TMP and with TEMP/TMP moved to the checkout drive, reads
 * Defender's state (counts only, no paths), and — in CI only — times the same
 * cells before, during and after a Defender exclusion so cache warmth can be
 * told apart from the exclusion itself. It asserts nothing.
 */

const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROUNDS = 6;
const BOUND_MS = 60_000;
const LINE = '    iPhone 17 Pro (94B8198C-8CF1-4860-994A-5669D3388BE8) (Shutdown) ';
const SED = "sed -n 's/.*(\\([A-F0-9-]\\{8,\\}\\)).*/\\1/p'";

function findOnPath(name, pathVar) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of String(pathVar || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

function cells(base, sh) {
  const pipeline = `printf '%s\\n' "$1" | ${SED} | head -1`;
  const noHead = `printf '%s\\n' "$1" | ${SED}`;
  const sedPath = sh ? path.join(path.dirname(sh), 'sed.exe') : null;
  const minimal = { PATH: base.PATH, SystemRoot: base.SystemRoot };
  const out = [
    ['sh (PATH): real pipeline', 'sh', ['-c', pipeline, 'sh', LINE], base],
    ['sh (PATH): -c true', 'sh', ['-c', 'true'], base],
    ['sh (PATH): printf | sed, no head', 'sh', ['-c', noHead, 'sh', LINE], base],
    ['sh (PATH): real pipeline, minimal env', 'sh', ['-c', pipeline, 'sh', LINE], minimal],
    ['node -e 0', process.execPath, ['-e', '0'], base],
    ['cmd /c exit', 'cmd', ['/c', 'exit', '0'], base],
  ];
  if (sh) out.push(['sh (absolute): real pipeline', sh, ['-c', pipeline, 'sh', LINE], base]);
  if (sedPath && fs.existsSync(sedPath)) {
    out.push(['sed.exe direct, line on stdin', sedPath, ['-n', 's/.*(\\([A-F0-9-]\\{8,\\}\\)).*/\\1/p'], base, LINE + '\n']);
  }
  return out;
}

test('in-tier: time the #4784 sh pipeline and its parts (win32 only; asserts nothing)', { skip: process.platform !== 'win32' && 'Windows-only' }, () => {
  const sh = findOnPath('sh', process.env.PATH || process.env.Path);
  const gitUsrSh = [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\sh.exe',
  ].filter((p) => fs.existsSync(p));
  const matrix = cells(process.env, sh);
  const runs = matrix.map(() => []);
  for (let round = 0; round < ROUNDS; round++) {
    for (let k = 0; k < matrix.length; k++) {
      const i = (k + round) % matrix.length;
      const [, bin, args, env, input] = matrix[i];
      const started = process.hrtime.bigint();
      const r = spawnSync(bin, args, { env, input, encoding: 'utf8', timeout: BOUND_MS, windowsHide: true });
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      runs[i].push(`${ms}${r.error ? '!' + (r.error.code || 'err') : r.status === 0 ? '' : '?' + r.status}`);
    }
  }
  const lines = [
    '### #4784 sh-pipeline timing inside the Windows conformance tier',
    '',
    `PATH \`sh\` resolves to: ${sh}`,
    `Git sh.exe present at: ${gitUsrSh.join(' ; ') || '(neither standard location)'}`,
    `PATH entries: ${String(process.env.PATH || process.env.Path || '').split(path.delimiter).length}`,
    `TEST_CONCURRENCY set: ${Object.hasOwn(process.env, 'TEST_CONCURRENCY')}`,
    '',
    `every run in execution order, ms (\`!code\` = spawn error, \`?n\` = exit status n); ${ROUNDS} rounds, round-robin, rotating start`,
    '',
    ...matrix.map(([label], i) => `- ${label}: ${runs[i].join(', ')}`),
  ];
  emit(lines.join('\n'));
});

function emit(report) {
  process.stdout.write(`\n${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`); } catch { /* summary is best effort */ }
  }
}

const BASH_ROUNDS = 20;
const BASH_SCRIPT = 'if [[ "$TEST_INPUT" =~ ^[0-9]+$ ]]; then echo MATCH; else echo NOMATCH; fi';
const POWERSHELL_BOUND_MS = 30_000;

function timeBash(bin, env) {
  const started = process.hrtime.bigint();
  const r = spawnSync(bin, [], { env: { ...env, TEST_INPUT: '6' }, input: BASH_SCRIPT, encoding: 'utf8', timeout: BOUND_MS, windowsHide: true });
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  return `${ms}${r.error ? '!' + (r.error.code || 'err') : r.status === 0 ? '' : '?' + r.status}`;
}

function summarize(samples) {
  const ms = samples.map((s) => parseInt(s, 10)).sort((a, b) => a - b);
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return `min ${ms[0]} / median ${at(0.5)} / p90 ${at(0.9)} / max ${ms[ms.length - 1]}`;
}

function powershell(command) {
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: POWERSHELL_BOUND_MS, windowsHide: true });
}

function quoteList(paths) {
  return paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
}

function runPhase(label, variants, rounds) {
  const samples = variants.map(() => []);
  for (let round = 0; round < rounds; round++) {
    for (let k = 0; k < variants.length; k++) {
      const i = (k + round) % variants.length;
      samples[i].push(timeBash(variants[i][1], variants[i][2]));
    }
  }
  return [
    `**${label}** (${rounds} rounds, round-robin, rotating start; every run in order, ms)`,
    '',
    ...variants.map(([name], i) => `- ${name}: ${summarize(samples[i])} | ${samples[i].join(', ')}`),
    '',
  ];
}

test('in-tier: time cold bash launches by temp drive and Defender state (win32 only; asserts nothing)', { skip: process.platform !== 'win32' && 'Windows-only' }, () => {
  const checkoutDrive = path.parse(process.cwd()).root;
  const probeTmp = fs.mkdtempSync(path.join(process.cwd(), '.tmp-bash-probe-'));
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => fs.existsSync(p)) || null;
  const onCheckoutDrive = { ...process.env, TEMP: probeTmp, TMP: probeTmp };
  const variants = [
    ['bash (PATH), default TEMP/TMP', 'bash', process.env],
    ['bash (PATH), TEMP/TMP on the checkout drive', 'bash', onCheckoutDrive],
  ];
  if (gitBash) {
    variants.push(['bash (absolute), default TEMP/TMP', gitBash, process.env]);
    variants.push(['bash (absolute), TEMP/TMP on the checkout drive', gitBash, onCheckoutDrive]);
  }
  const lines = [
    '### cold `bash` launch: temp drive and Defender, inside the Windows conformance tier',
    '',
    `checkout drive: ${checkoutDrive} ; default temp drive: ${path.parse(os.tmpdir()).root} ; Git bash at: ${gitBash || '(neither standard location)'}`,
    '',
  ];
  try {
    const status = powershell('$s = Get-MpComputerStatus; "RealTimeProtectionEnabled=$($s.RealTimeProtectionEnabled) IsTamperProtected=$($s.IsTamperProtected) AMRunningMode=$($s.AMRunningMode)"');
    const prefs = powershell('$p = Get-MpPreference; "ExclusionPath count=$(@($p.ExclusionPath).Count) ExclusionProcess count=$(@($p.ExclusionProcess).Count) DisableRealtimeMonitoring=$($p.DisableRealtimeMonitoring)"');
    lines.push(`Defender: ${String(status.stdout || status.error || '(no output)').trim()} ; ${String(prefs.stdout || prefs.error || '(no output)').trim()}`, '');
    lines.push(...runPhase('phase 1: baseline', variants, BASH_ROUNDS));
    if (process.env.GITHUB_ACTIONS === 'true' && gitBash) {
      const targets = [path.dirname(path.dirname(gitBash)), probeTmp, os.tmpdir()];
      const added = powershell(`Add-MpPreference -ExclusionPath ${quoteList(targets)}; 'applied'`);
      lines.push(`Defender exclusion for the Git directory and both temp directories: ${added.status === 0 ? 'applied' : `failed (status ${added.status}${added.error ? ' ' + (added.error.code || 'err') : ''})`}`, '');
      lines.push(...runPhase('phase 2: with the Defender exclusion', variants, BASH_ROUNDS));
      const removed = powershell(`Remove-MpPreference -ExclusionPath ${quoteList(targets)}; 'removed'`);
      lines.push(`Defender exclusion removed: ${removed.status === 0 ? 'yes' : `failed (status ${removed.status})`}`, '');
      lines.push(...runPhase('phase 3: baseline again (compare with phase 1 to separate cache warmth from the exclusion)', variants, BASH_ROUNDS));
    } else {
      lines.push('Defender exclusion phases skipped (not CI, or Git bash not found).', '');
    }
  } finally {
    // The report is emitted BEFORE cleanup can fail, and the probe dir lives on the
    // checkout drive on purpose, which helpers.cjs cleanup() refuses (outside the temp roots).
    emit(lines.join('\n'));
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- the probe dir must sit on the checkout drive to be measured, which helpers.cleanup() refuses; a leftover is harmless on an ephemeral runner
    try { fs.rmSync(probeTmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
