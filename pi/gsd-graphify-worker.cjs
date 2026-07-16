'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeStatus(statusPath, status) {
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
}

function removeOwnedLock(lockPath, pid) {
  try {
    if (Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10) === pid) fs.unlinkSync(lockPath);
  } catch { /* already absent or replaced */ }
}

function acquireParentLock(lockPath, ownerPid) {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      if (ownerPid > 0 && Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10) === ownerPid) {
        fs.writeFileSync(lockPath, String(process.pid));
        return true;
      }
    } catch { /* parent lock is not visible yet */ }
    Atomics.wait(waitCell, 0, 0, 2);
  }
  return false;
}

function run(payload) {
  const cwd = process.cwd();
  const graphDir = path.join(cwd, '.planning', 'graphs');
  const lockPath = path.join(graphDir, '.rebuild.lock');
  const statusPath = path.join(graphDir, '.last-build-status.json');
  const startedAt = Number.isFinite(payload?.startedAt) ? payload.startedAt : Date.now();
  const head = typeof payload?.head === 'string' ? payload.head : '';
  const graphifyBin = typeof payload?.graphifyBin === 'string' ? payload.graphifyBin : '';
  const ownerPid = Number.isInteger(payload?.ownerPid) ? payload.ownerPid : 0;
  if (!acquireParentLock(lockPath, ownerPid)) return;

  let exitCode = 1;
  try {
    if (!graphifyBin) throw new Error('Missing graphify executable');
    const result = spawnSync(graphifyBin, ['update', '.'], { cwd, stdio: 'ignore', windowsHide: true });
    exitCode = Number.isInteger(result.status) ? result.status : 1;
    const outputDir = path.join(cwd, 'graphify-out');
    const graphPath = path.join(outputDir, 'graph.json');
    if (exitCode === 0 && fs.existsSync(graphPath)) {
      fs.copyFileSync(graphPath, path.join(graphDir, 'graph.json'));
      for (const file of ['graph.html', 'GRAPH_REPORT.md']) {
        try { fs.copyFileSync(path.join(outputDir, file), path.join(graphDir, file)); } catch { /* optional output */ }
      }
      fs.copyFileSync(path.join(graphDir, 'graph.json'), path.join(graphDir, '.last-build-snapshot.json'));
    }
  } catch {
    exitCode = 1;
  } finally {
    try {
      writeStatus(statusPath, {
        ts: new Date().toISOString(),
        status: exitCode === 0 ? 'ok' : 'failed',
        exit_code: exitCode,
        duration_ms: Math.max(0, Date.now() - startedAt),
        head_at_build: head,
        graphify_version: null,
      });
    } catch { /* status is advisory */ }
    removeOwnedLock(lockPath, process.pid);
  }
}

if (require.main === module) {
  let payload = null;
  try { payload = JSON.parse(process.argv[2] || 'null'); } catch { /* worker records failure */ }
  run(payload);
}

module.exports = { run };
