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
 */

const { test } = require('node:test');
const fs = require('node:fs');
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
  const report = lines.join('\n');
  process.stdout.write(`\n${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`); } catch { /* summary is best effort */ }
  }
});
