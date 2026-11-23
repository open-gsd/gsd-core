'use strict';

/**
 * config-value-resolver-undeclared.test.cjs
 *
 * `allowUndeclared` (#6032, ADR-1411 Decision 5): a key no family declares still resolves over the
 * family-A FILE layers through the one precedence implementation, with no schema or built-in
 * default, so the activation gate needs no second walk of its own.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { resolveConfigValue } = require('../gsd-core/bin/lib/config-value-resolver.cjs');

const KEY = 'zz_undeclared_gate.enabled';

function withProject(layers, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-undeclared-'));
  const keys = ['GSD_HOME', 'GSD_WORKSTREAM', 'GSD_PROJECT'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GSD_HOME = path.join(root, 'home');
  delete process.env.GSD_WORKSTREAM;
  delete process.env.GSD_PROJECT;
  try {
    const cwd = path.join(root, 'project');
    fs.mkdirSync(path.join(cwd, '.planning', 'workstreams', 'ws1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'home', '.gsd'), { recursive: true });
    if (layers.root !== undefined) fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), layers.root);
    if (layers.workstream !== undefined) {
      fs.writeFileSync(path.join(cwd, '.planning', 'workstreams', 'ws1', 'config.json'), layers.workstream);
    }
    if (layers.global !== undefined) fs.writeFileSync(path.join(root, 'home', '.gsd', 'defaults.json'), layers.global);
    return run(cwd);
  } finally {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
    cleanup(root);
  }
}

describe('resolveConfigValue allowUndeclared', () => {
  test('without the option an undeclared key is not configured, even when a file sets it', () => {
    withProject({ root: JSON.stringify({ zz_undeclared_gate: { enabled: true } }) }, (cwd) => {
      const r = resolveConfigValue(KEY, { cwd, quiet: true });
      assert.equal(r.found, false);
    });
  });

  test('with the option the root layer answers and names itself', () => {
    withProject({ root: JSON.stringify({ zz_undeclared_gate: { enabled: true } }) }, (cwd) => {
      const r = resolveConfigValue(KEY, { cwd, quiet: true, allowUndeclared: true });
      assert.equal(r.found, true);
      assert.equal(r.value, true);
      assert.equal(r.layer, 'root');
    });
  });

  test('a workstream layer outranks the root', () => {
    withProject({
      root: JSON.stringify({ zz_undeclared_gate: { enabled: true } }),
      workstream: JSON.stringify({ zz_undeclared_gate: { enabled: false } }),
    }, (cwd) => {
      process.env.GSD_WORKSTREAM = 'ws1';
      const r = resolveConfigValue(KEY, { cwd, quiet: true, allowUndeclared: true });
      assert.equal(r.found, true);
      assert.equal(r.value, false);
      assert.equal(r.layer, 'workstream');
    });
  });

  test('the global layer answers only when honorGlobal allows the key', () => {
    withProject({ global: JSON.stringify({ zz_undeclared_gate: { enabled: true } }) }, (cwd) => {
      assert.equal(resolveConfigValue(KEY, { cwd, quiet: true, allowUndeclared: true, honorGlobal: () => false }).found, false);
      const r = resolveConfigValue(KEY, { cwd, quiet: true, allowUndeclared: true, honorGlobal: () => true });
      assert.equal(r.found, true);
      assert.equal(r.layer, 'global-defaults');
    });
  });

  test('nothing configured and a prototype-pollution key both resolve to not found', () => {
    withProject({ root: '{}' }, (cwd) => {
      assert.equal(resolveConfigValue(KEY, { cwd, quiet: true, allowUndeclared: true }).found, false);
      assert.equal(resolveConfigValue('__proto__.enabled', { cwd, quiet: true, allowUndeclared: true }).found, false);
      assert.equal(({}).enabled, undefined);
    });
  });

  test('a malformed layer degrades quietly instead of throwing', () => {
    withProject({ root: '{ nope' }, (cwd) => {
      const r = resolveConfigValue(KEY, { cwd, quiet: true, allowUndeclared: true });
      assert.equal(r.found, false);
    });
  });
});
