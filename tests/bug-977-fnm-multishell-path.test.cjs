'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #977: `resolveNodeRunner()` bakes an ephemeral fnm multishell shim path
 * (e.g. `C:/Users/u/AppData/Local/fnm_multishells/<pid>_<ts>/node.exe`) into
 * managed `.js` hook commands. fnm cleans up these per-shell-session directories
 * when the shell exits, so the captured path later points at nothing — every
 * managed hook fails to spawn until reinstall.
 *
 * Fix: when `normalizeNodePath` detects a path matching the fnm multishell
 * directory pattern (`fnm_multishells/<id>/node(\.exe)?$`), it probes a stable
 * alias path derived from `FNM_DIR` or `APPDATA` env vars (with injected
 * `existsSync` for testability) and returns the first that exists. Falls back to
 * the raw execPath if no stable alias is found.
 *
 * All assertions go against exported function return values — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { normalizeNodePath, resolveNodeRunner } = INSTALL;

// ─── Synthetic paths used across tests ───────────────────────────────────────

const EPHEMERAL_FNM_WIN = 'C:/Users/u/AppData/Local/fnm_multishells/15600_1781041703752/node.exe';
const EPHEMERAL_FNM_WIN_BACKSLASH = 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\15600_1781041703752\\node.exe';
const FNM_DIR_WIN = 'C:/Users/u/AppData/Roaming/fnm';
const APPDATA_WIN = 'C:/Users/u/AppData/Roaming';
const STABLE_FNM_DIR_NODE = `${FNM_DIR_WIN}/aliases/default/node.exe`;
const STABLE_APPDATA_NODE = `${APPDATA_WIN}/fnm/aliases/default/node.exe`;

// ─── normalizeNodePath — fnm multishell ephemeral path → stable alias ────────

describe('Bug #977: normalizeNodePath — fnm multishell path with FNM_DIR → stable alias', () => {
  test('forward-slash Windows ephemeral path + FNM_DIR set + alias exists → stable FNM_DIR alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN },
      existsSync: p => p === STABLE_FNM_DIR_NODE,
    });
    assert.equal(
      result,
      STABLE_FNM_DIR_NODE,
      `expected stable FNM_DIR alias, got: ${result}`,
    );
  });

  test('backslash Windows ephemeral path + FNM_DIR set + alias exists → stable FNM_DIR alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN_BACKSLASH, {
      env: { FNM_DIR: FNM_DIR_WIN },
      existsSync: p => p === STABLE_FNM_DIR_NODE,
    });
    assert.equal(
      result,
      STABLE_FNM_DIR_NODE,
      `expected stable FNM_DIR alias, got: ${result}`,
    );
  });

  test('FNM_DIR alias does not exist → falls through to APPDATA alias → returns APPDATA alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN, APPDATA: APPDATA_WIN },
      existsSync: p => p === STABLE_APPDATA_NODE, // FNM_DIR alias absent, APPDATA alias present
    });
    assert.equal(
      result,
      STABLE_APPDATA_NODE,
      `expected stable APPDATA alias, got: ${result}`,
    );
  });

  test('no alias exists → returns raw execPath unchanged (graceful fallback)', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN, APPDATA: APPDATA_WIN },
      existsSync: () => false, // nothing exists
    });
    assert.equal(
      result,
      EPHEMERAL_FNM_WIN,
      `expected raw execPath fallback, got: ${result}`,
    );
  });

  test('no FNM_DIR or APPDATA in env → returns raw execPath unchanged', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: {},
      existsSync: () => false,
    });
    assert.equal(
      result,
      EPHEMERAL_FNM_WIN,
      `expected raw execPath fallback, got: ${result}`,
    );
  });
});

// ─── normalizeNodePath — non-fnm paths are NOT affected by the new branch ────

describe('Bug #977: normalizeNodePath — non-fnm paths are unaffected (no regression to existing behavior)', () => {
  test('NVM path is unchanged', () => {
    const nvm = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    assert.equal(normalizeNodePath(nvm), nvm);
  });

  test('Intel Homebrew Cellar path still maps to stable symlink', () => {
    assert.equal(
      normalizeNodePath('/usr/local/Cellar/node/25.8.1/bin/node'),
      '/usr/local/bin/node',
    );
  });

  test('Apple Silicon Homebrew Cellar path still maps to stable symlink', () => {
    assert.equal(
      normalizeNodePath('/opt/homebrew/Cellar/node/25.8.1/bin/node'),
      '/opt/homebrew/bin/node',
    );
  });

  test('regular Windows nodejs path is unchanged', () => {
    const win = 'C:\\Program Files\\nodejs\\node.exe';
    assert.equal(normalizeNodePath(win), win);
  });

  test('empty string is returned as-is', () => {
    assert.equal(normalizeNodePath(''), '');
  });

  test('null is returned as-is', () => {
    assert.equal(normalizeNodePath(null), null);
  });
});

// ─── normalizeNodePath — already-stable fnm alias path is not re-processed ───

describe('Bug #977: normalizeNodePath — already-stable fnm alias path passes through unchanged', () => {
  test('stable FNM_DIR alias path is returned as-is', () => {
    assert.equal(
      normalizeNodePath(STABLE_FNM_DIR_NODE),
      STABLE_FNM_DIR_NODE,
    );
  });
});

// ─── normalizeNodePath — false-positive guard: non-numeric id must NOT remap ──

describe('Bug #977: normalizeNodePath — non-ephemeral fnm_multishells path is not remapped', () => {
  test('non-numeric id segment (e.g. custom-dir) returns raw execPath unchanged even when alias exists', () => {
    const nonEphemeral = 'C:/Users/u/AppData/Local/fnm_multishells/custom-dir/node.exe';
    const stableAlias = 'C:/Users/u/AppData/Roaming/fnm/aliases/default/node.exe';
    const result = normalizeNodePath(nonEphemeral, {
      env: { FNM_DIR: 'C:/Users/u/AppData/Roaming/fnm' },
      // existsSync returns true for the alias to prove the regex — not the existsSync — is the guard
      existsSync: p => p === stableAlias,
    });
    assert.equal(
      result,
      nonEphemeral,
      `expected raw execPath (non-ephemeral id must not be remapped), got: ${result}`,
    );
  });
});

// ─── resolveNodeRunner — opts pass-through ────────────────────────────────────

describe('Bug #977: resolveNodeRunner — passes opts through to normalizeNodePath', () => {
  test('fnm multishell execPath is resolved to stable alias via injected opts', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: EPHEMERAL_FNM_WIN,
        configurable: true,
      });
      const runner = resolveNodeRunner({
        env: { FNM_DIR: FNM_DIR_WIN },
        existsSync: p => p === STABLE_FNM_DIR_NODE,
      });
      assert.equal(
        runner,
        JSON.stringify(STABLE_FNM_DIR_NODE),
        `expected stable FNM_DIR alias quoted, got: ${runner}`,
      );
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});
