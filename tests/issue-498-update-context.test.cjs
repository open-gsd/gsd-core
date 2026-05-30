'use strict';
process.env.GSD_TEST_MODE = '1';

// Issue #498 (candidate 3): resolveUpdateContext ports update.md's ~280-line
// get_installed_version bash into a pure, injected-fs function. It returns the
// same 4-field contract the workflow emits: { installedVersion, scope, runtime,
// gsdDir }. The fs is injected (exists/readFile) so the precedence cascade is
// finally testable without a live multi-runtime install.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const nodeFs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const GSD_TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const { resolveUpdateContext } = require(
  path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'update-context.cjs'),
);

// Build an injected fs from a map of absolute path -> contents. Marker files
// (VERSION, workflows/update.md) just need to "exist".
function fakeFs(files) {
  const set = new Map(Object.entries(files));
  return {
    exists: (p) => set.has(p),
    readFile: (p) => (set.has(p) ? set.get(p) : null),
  };
}

const HOME = '/home/u';
const CWD = '/work/proj';

function ver(dir) { return `${dir}/get-shit-done/VERSION`; }
function marker(dir) { return `${dir}/get-shit-done/workflows/update.md`; }

describe('resolveUpdateContext: scope cascade', () => {
  test('GLOBAL claude install under $HOME/.claude', () => {
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.deepEqual(r, {
      installedVersion: '1.40.0',
      scope: 'GLOBAL',
      runtime: 'claude',
      gsdDir: `${HOME}/.claude`,
    });
  });

  test('LOCAL install under ./.claude takes priority over global', () => {
    const fs = fakeFs({
      [ver(`${CWD}/.claude`)]: '1.39.0\n', [marker(`${CWD}/.claude`)]: 'x',
      [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.39.0');
    assert.equal(r.gsdDir, `${CWD}/.claude`);
  });

  test('cwd === home does NOT misdetect as LOCAL (dedup)', () => {
    const fs = fakeFs({ [ver(`${HOME}/.claude`)]: '1.40.0\n', [marker(`${HOME}/.claude`)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: HOME, env: {}, fs });
    assert.equal(r.scope, 'GLOBAL');
  });

  test('runtime detected but VERSION missing -> 0.0.0, keep scope/runtime', () => {
    const fs = fakeFs({ [marker(`${HOME}/.gemini`)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.installedVersion, '0.0.0');
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'gemini');
  });

  test('no install anywhere -> UNKNOWN / claude / empty gsdDir', () => {
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: fakeFs({}) });
    assert.deepEqual(r, { installedVersion: '0.0.0', scope: 'UNKNOWN', runtime: 'claude', gsdDir: '' });
  });
});

describe('resolveUpdateContext: runtime probing + env overrides', () => {
  test('opencode global under $HOME/.config/opencode', () => {
    const dir = `${HOME}/.config/opencode`;
    const fs = fakeFs({ [ver(dir)]: '1.40.0\n', [marker(dir)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs });
    assert.equal(r.runtime, 'opencode');
    assert.equal(r.gsdDir, dir);
  });

  test('CLAUDE_CONFIG_DIR env override locates a custom global dir', () => {
    const custom = '/opt/claude-home';
    const fs = fakeFs({ [ver(custom)]: '1.40.0\n', [marker(custom)]: 'x' });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: { CLAUDE_CONFIG_DIR: custom }, fs });
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'claude');
    assert.equal(r.gsdDir, custom);
  });

  test('preferredConfigDir fast-path: trusts a validated custom dir as GLOBAL', () => {
    const custom = '/opt/gsd-x';
    const fs = fakeFs({ [ver(custom)]: '1.41.0\n', [marker(custom)]: 'x' });
    const r = resolveUpdateContext({
      home: HOME, cwd: CWD, env: {}, fs,
      preferredConfigDir: custom, preferredRuntime: 'kilo',
    });
    assert.equal(r.scope, 'GLOBAL');
    assert.equal(r.runtime, 'kilo');
    assert.equal(r.gsdDir, custom);
    assert.equal(r.installedVersion, '1.41.0');
  });
});

describe('gsd-tools update-context (CLI): emits the JSON contract', () => {
  test('--config-dir fixture resolves to the documented 4-field JSON', () => {
    const tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uc-'));
    try {
      nodeFs.mkdirSync(path.join(tmp, 'get-shit-done', 'workflows'), { recursive: true });
      nodeFs.writeFileSync(path.join(tmp, 'get-shit-done', 'VERSION'), '1.42.0\n');
      nodeFs.writeFileSync(path.join(tmp, 'get-shit-done', 'workflows', 'update.md'), 'x');
      const out = execFileSync(
        process.execPath,
        [GSD_TOOLS, 'update-context', '--config-dir', tmp, '--runtime', 'kilo', '--json'],
        { encoding: 'utf8', env: { ...process.env, GSD_TEST_MODE: '1' } },
      );
      const ctx = JSON.parse(out);
      assert.deepEqual(Object.keys(ctx).sort(), ['gsdDir', 'installedVersion', 'runtime', 'scope']);
      assert.equal(ctx.installedVersion, '1.42.0');
      assert.equal(ctx.scope, 'GLOBAL');
      assert.equal(ctx.runtime, 'kilo');
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
