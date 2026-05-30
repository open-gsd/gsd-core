/**
 * Bug #3608: /gsd:update must model Antigravity as a first-class runtime, so an
 * Antigravity install (~/.gemini/antigravity*) is not misclassified as base
 * Gemini.
 *
 * The installer (bin/install.js) and SDK already treat Antigravity as a distinct
 * runtime with its own config dirs, env var (ANTIGRAVITY_CONFIG_DIR), and CLI
 * flag (--antigravity). The update flow must agree.
 *
 * Relocation (#498): the update flow's runtime/scope detection moved out of
 * ~280 lines of inline bash in update.md into the tested projection
 * `get-shit-done/bin/lib/update-context.cjs` (resolveUpdateContext). The
 * antigravity-first-class contract now lives there as data + behavior, so this
 * test asserts it on the projection. The only piece still authored in update.md
 * is the execution_context path classification (prose the agent applies), which
 * this test still checks for antigravity-before-gemini ordering.
 *
 * Order matters: every probe list / env ladder that contains a Gemini entry
 * MUST place the more-specific Antigravity entry first, else an install with
 * both signals present falls through to gemini.
 */

'use strict';
process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  RUNTIME_DIRS,
  inferPreferredRuntime,
  envRuntimeDirs,
  resolveUpdateContext,
} = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'update-context.cjs'));
const UPDATE_MD = path.join(ROOT, 'get-shit-done', 'workflows', 'update.md');

function runtimeOrder() {
  return RUNTIME_DIRS.map(([rt]) => rt);
}
function firstIndex(arr, token) {
  return arr.indexOf(token);
}

describe('bug #3608 / #498: update-context models Antigravity as a first-class runtime', () => {
  test('RUNTIME_DIRS lists antigravity before gemini', () => {
    const order = runtimeOrder();
    const antIdx = firstIndex(order, 'antigravity');
    const gemIdx = firstIndex(order, 'gemini');
    assert.notStrictEqual(antIdx, -1, 'RUNTIME_DIRS missing antigravity');
    assert.notStrictEqual(gemIdx, -1, 'RUNTIME_DIRS missing gemini');
    assert.ok(antIdx < gemIdx, `antigravity (@${antIdx}) must precede gemini (@${gemIdx}) — first match wins`);
  });

  test('RUNTIME_DIRS includes antigravity 2.x (ide/cli) + legacy dirs', () => {
    const dirs = RUNTIME_DIRS.filter(([rt]) => rt === 'antigravity').map(([, d]) => d);
    assert.ok(dirs.includes('.gemini/antigravity-ide'), 'missing .gemini/antigravity-ide');
    assert.ok(dirs.includes('.gemini/antigravity-cli'), 'missing .gemini/antigravity-cli');
    assert.ok(dirs.includes('.gemini/antigravity'), 'missing legacy .gemini/antigravity fallback');
    // All antigravity dirs precede the .gemini probe.
    const order = RUNTIME_DIRS.map(([, d]) => d);
    const gemIdx = order.indexOf('.gemini');
    for (const d of dirs) {
      assert.ok(order.indexOf(d) < gemIdx, `${d} must precede .gemini in the probe order`);
    }
  });

  test('env inference recognizes ANTIGRAVITY_CONFIG_DIR before GEMINI_CONFIG_DIR', () => {
    const rt = inferPreferredRuntime({
      fs: { exists: () => false },
      env: { ANTIGRAVITY_CONFIG_DIR: '/x', GEMINI_CONFIG_DIR: '/y' },
      preferredConfigDir: '',
    });
    assert.equal(rt, 'antigravity', 'both env vars set must resolve to antigravity, not gemini');
  });

  test('envRuntimeDirs emits an antigravity entry (before gemini) when ANTIGRAVITY_CONFIG_DIR is set', () => {
    const entries = envRuntimeDirs({ env: { ANTIGRAVITY_CONFIG_DIR: '/x/ag', GEMINI_CONFIG_DIR: '/x/gem' }, home: '/home/u' });
    const order = entries.map(([rt]) => rt);
    assert.ok(order.includes('antigravity'), 'expected an antigravity env candidate');
    assert.ok(order.indexOf('antigravity') < order.indexOf('gemini'), 'antigravity env candidate must precede gemini');
  });

  test('behavioral: an Antigravity install resolves to runtime "antigravity", not "gemini"', () => {
    const HOME = '/home/u';
    const agDir = `${HOME}/.gemini/antigravity`;
    const fakeFs = {
      exists: (p) => p === `${agDir}/get-shit-done/VERSION` || p === `${agDir}/get-shit-done/workflows/update.md`,
      readFile: (p) => (p === `${agDir}/get-shit-done/VERSION` ? '1.40.0\n' : null),
    };
    const r = resolveUpdateContext({ home: HOME, cwd: '/work', env: {}, fs: fakeFs });
    assert.equal(r.runtime, 'antigravity');
    assert.equal(r.gsdDir, agDir);
  });

  test('update.md execution_context classification still lists antigravity paths before /.gemini/', () => {
    const content = fs.readFileSync(UPDATE_MD, 'utf-8');
    const antIde = content.indexOf('/.gemini/antigravity-ide/');
    const gemBare = content.indexOf('`/.gemini/` -> `gemini`');
    assert.notStrictEqual(antIde, -1, 'update.md must document the antigravity-ide execution_context path');
    assert.notStrictEqual(gemBare, -1, 'update.md must document the bare /.gemini/ -> gemini classification');
    assert.ok(antIde < gemBare, 'antigravity path classification must precede the bare /.gemini/ rule');
  });
});
