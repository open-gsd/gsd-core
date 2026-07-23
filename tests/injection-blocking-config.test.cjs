'use strict';

/**
 * #1577 — `security.injection_blocking` is a first-class config key.
 *
 * The gsd-read-injection-scanner hook reads `.planning/config.json`
 * `security.injection_blocking` to decide whether a HIGH detection blocks
 * (opt-in) vs. stays advisory (default). Before this, the key was unregistered:
 * `isValidConfigKey` returned false and `gsd config-set security.injection_blocking`
 * was rejected as "Unknown config key" — the knob was settable only by hand-editing
 * config.json. These tests lock the registration + the nested write shape the hook
 * reads, and the advisory-by-default contract.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/configuration.cjs');

describe('#1577 — security.injection_blocking config key', () => {
  test('isValidConfigKey accepts security.injection_blocking', () => {
    assert.ok(
      isValidConfigKey('security.injection_blocking'),
      'security.injection_blocking must be a valid config key',
    );
  });

  test('bare security section is not a settable leaf key', () => {
    assert.ok(
      !isValidConfigKey('security'),
      'bare "security" must be rejected (use security.injection_blocking)',
    );
  });

  test('CONFIG_DEFAULTS ships injection_blocking = false (advisory by default)', () => {
    assert.equal(
      CONFIG_DEFAULTS.security && CONFIG_DEFAULTS.security.injection_blocking,
      false,
      'default must be false so the hook stays advisory unless explicitly opted in',
    );
  });

  test('config-set writes the nested shape the hook reads, and round-trips', () => {
    const proj = createTempProject();
    try {
      const res = runGsdTools(['config-set', 'security.injection_blocking', 'true'], proj);
      assert.ok(res.success, `config-set should succeed: ${res.output || ''}`);

      // The hook reads cfg.security?.injection_blocking === true — assert the
      // on-disk shape is the nested object it expects, not a flat dotted key.
      const cfg = JSON.parse(fs.readFileSync(path.join(proj, '.planning', 'config.json'), 'utf8'));
      assert.equal(cfg.security.injection_blocking, true, 'must persist nested security.injection_blocking');
      assert.equal(cfg['security.injection_blocking'], undefined, 'must NOT persist a flat dotted key');

      const get = runGsdTools(['config-get', 'security.injection_blocking'], proj);
      assert.ok(get.success, `config-get should succeed: ${get.output || ''}`);
      assert.match(String(get.output || ''), /true/, 'config-get should read back true');
    } finally {
      cleanup(proj);
    }
  });

  test('a fresh project has no injection_blocking key — hook sees absent → advisory', () => {
    const proj = createTempProject();
    try {
      const cfgPath = path.join(proj, '.planning', 'config.json');
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      // The hook's exact guard: cfg.security?.injection_blocking === true.
      const blocking = cfg.security && cfg.security.injection_blocking === true;
      assert.ok(!blocking, 'absent key must evaluate to advisory (not blocking)');
    } finally {
      cleanup(proj);
    }
  });
});
