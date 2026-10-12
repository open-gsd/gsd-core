'use strict';

/**
 * opencode-install-state.test.cjs — the install records which OpenCode generation it targets and
 * update-context surfaces it (ADR-5331 D2, epic #5331, Phase 1 #5337).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const migrations = require('../gsd-core/bin/lib/installer-migrations.cjs');
const { resolveUpdateContext } = require('../gsd-core/bin/lib/update-context.cjs');

function tmpConfigDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-state-')));
  t.after(() => cleanup(dir));
  return dir;
}

test('recordHostGeneration writes the generation, is idempotent, and keeps the migration journal', (t) => {
  const dir = tmpConfigDir(t);
  migrations.writeInstallState(dir, { schemaVersion: 1, appliedMigrations: [{ id: '001-x' }] });
  migrations.recordHostGeneration(dir, { generation: 2, version: '2.0.27' });
  const state = migrations.readInstallState(dir);
  assert.deepEqual(state.hostGeneration, { runtime: 'opencode', generation: 2, version: '2.0.27' });
  assert.deepEqual(state.appliedMigrations, [{ id: '001-x' }]);

  const file = path.join(dir, migrations.INSTALL_STATE_NAME);
  const before = fs.readFileSync(file, 'utf8');
  migrations.recordHostGeneration(dir, { generation: 2, version: '2.0.27' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  migrations.recordHostGeneration(dir, { generation: 1, version: '1.19.0' });
  assert.equal(migrations.readInstallState(dir).hostGeneration.generation, 1);
});

test('readInstallState ignores a malformed hostGeneration', (t) => {
  const dir = tmpConfigDir(t);
  fs.writeFileSync(
    path.join(dir, migrations.INSTALL_STATE_NAME),
    JSON.stringify({ schemaVersion: 1, appliedMigrations: [], hostGeneration: { runtime: 'opencode', generation: 7 } }),
  );
  assert.equal(migrations.readInstallState(dir).hostGeneration, undefined);
});

function ctxFor(files) {
  return {
    home: '/h',
    cwd: '/h/proj',
    env: {},
    preferredConfigDir: '/h/.config/opencode',
    fs: {
      exists: (p) => Object.hasOwn(files, p),
      readFile: (p) => (Object.hasOwn(files, p) ? files[p] : null),
    },
  };
}

test('update-context reports the recorded OpenCode generation for an opencode install only', () => {
  const base = {
    '/h/.config/opencode/gsd-core/VERSION': '1.16.0',
    '/h/.config/opencode/gsd-core/workflows/update.md': 'x',
    '/h/.config/opencode/opencode.json': '{}',
  };
  const withState = {
    ...base,
    '/h/.config/opencode/gsd-install-state.json': JSON.stringify({ hostGeneration: { runtime: 'opencode', generation: 2, version: '2.0.27' } }),
  };
  assert.equal(resolveUpdateContext(ctxFor(withState)).hostGeneration, 2);
  assert.equal('hostGeneration' in resolveUpdateContext(ctxFor(base)), false);
  assert.equal('hostGeneration' in resolveUpdateContext(ctxFor({ ...withState, '/h/.config/opencode/gsd-install-state.json': '{not json' })), false);
});
