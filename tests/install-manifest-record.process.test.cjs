'use strict';

/**
 * #6331: tryFileHash never blocks and never loops forever.
 *
 * A process-contract test: each row runs its subject in a child, because the failure it guards
 * against is a hang (a blocking read of a FIFO, a read loop with no end-of-file exit). Only a
 * child killed by SIGKILL on a timeout turns that hang into a failed row instead of a stuck
 * test file; the child installs SIGTERM handlers it cannot run while blocked.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { copyRuntimeFixture } = require('./helpers/install-shared.cjs');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = 'gsd-file-manifest.json';
const FULL = { baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('#6331 (real process: a hang must fail the row, not the file): tryFileHash never blocks', () => {
  test('a manifest key that names a FIFO under a synced destination does not hang the apply', { skip: process.platform === 'win32' && 'no mkfifo on Windows' }, (t) => {
    const { root, configDir } = copyRuntimeFixture({ runtime: 'claude', scope: 'global' });
    t.after(() => cleanup(root));
    const manifestPath = path.join(configDir, MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const key = Object.keys(manifest.files).filter((k) => /^skills\/gsd-[^/]+\/SKILL\.md$/.test(k)).sort()[0];
    assert.ok(key, 'precondition: the install recorded a skill');
    // An older skill text GSD recorded, so the apply rewrites it and re-records it.
    const skillPath = path.join(configDir, ...key.split('/'));
    fs.writeFileSync(skillPath, 'older skill text\n');
    manifest.files[key] = sha256('older skill text\n');
    const fifoKey = `${path.posix.dirname(key)}/notes.md`;
    const fifoPath = path.join(configDir, ...fifoKey.split('/'));
    throwIfFailed(runHook(fifoPath, [], { interpreter: 'mkfifo', timeoutMs: PROBE_TIMEOUT_MS }), `mkfifo ${fifoPath}`);
    manifest.files[fifoKey] = sha256('fifo\n');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const script = `
      const path = require('path');
      const lib = ${JSON.stringify(LIB)};
      const { applySurface } = require(path.join(lib, 'surface.cjs'));
      const { loadSkillsManifest } = require(path.join(lib, 'install-profiles.cjs'));
      const { resolveRuntimeArtifactLayout } = require(path.join(lib, 'runtime-artifact-layout.cjs'));
      const { CLUSTERS } = require(path.join(lib, 'clusters.cjs'));
      const configDir = ${JSON.stringify(configDir)};
      const layout = resolveRuntimeArtifactLayout('claude', configDir, 'global');
      applySurface(configDir, layout, loadSkillsManifest(${JSON.stringify(REAL_COMMANDS_DIR)}), CLUSTERS, undefined,
        { surfaceState: ${JSON.stringify(FULL)} });
      process.stdout.write('applied');
    `;
    const r = runNode(['-e', script], { timeoutMs: INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL', env: process.env });
    assert.equal(r.timedOut, false, `the apply returned: ${r.summary}`);
    assert.equal(r.exitCode, 0, r.summary);
    assert.equal(r.stdout, 'applied');
    const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files;
    assert.equal(files[fifoKey], sha256('fifo\n'), 'the FIFO entry is left as recorded');
    const rewritten = fs.readFileSync(skillPath);
    assert.notEqual(rewritten.toString(), 'older skill text\n', 'sanity: the apply rewrote the skill');
    assert.equal(files[key], sha256(rewritten), 'the rewritten skill is still re-recorded');
  });

  test('a file that is shorter than fstat reports ends the read and is not hashed', (t) => {
    const dir = createTempDir('gsd-6331-shrink-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, 'y'.repeat(3000));
    // fstat stubbed to report 10 bytes more than the file holds: a read loop without its
    // end-of-file exit would never return.
    const script = `
      const fs = require('fs');
      const realFstat = fs.fstatSync;
      fs.fstatSync = (fd, ...rest) => {
        const st = realFstat(fd, ...rest);
        const size = typeof st.size === 'bigint' ? st.size + 10n : st.size + 10;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size });
      };
      const { tryFileHash } = require(${JSON.stringify(path.join(LIB, 'install-manifest-record.cjs'))});
      const h = tryFileHash(${JSON.stringify(file)});
      fs.fstatSync = realFstat;
      process.stdout.write(JSON.stringify({ h }));
    `;
    const r = runNode(['-e', script], { timeoutMs: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assert.equal(r.timedOut, false, `the read returned: ${r.summary}`);
    assert.equal(r.exitCode, 0, r.summary);
    // An early end of file means the file changed while it was read, so no partial hash is
    // returned, even when the size is back to what fstat said.
    assert.deepEqual(JSON.parse(r.stdout), { h: null });
  });
});
