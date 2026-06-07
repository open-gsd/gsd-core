process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

describe('getGlobalConfigDir (Windsurf)', () => {
  let originalWindsurfConfigDir;

  beforeEach(() => {
    originalWindsurfConfigDir = process.env.WINDSURF_CONFIG_DIR;
    delete process.env.WINDSURF_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalWindsurfConfigDir !== undefined) {
      process.env.WINDSURF_CONFIG_DIR = originalWindsurfConfigDir;
    } else {
      delete process.env.WINDSURF_CONFIG_DIR;
    }
  });

  test('returns ~/.codeium/windsurf with no env var or explicit dir', () => {
    const result = getGlobalConfigDir('windsurf');
    assert.strictEqual(result, path.join(os.homedir(), '.codeium', 'windsurf'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalConfigDir('windsurf', '/custom/windsurf-path');
    assert.strictEqual(result, '/custom/windsurf-path');
  });

  test('respects WINDSURF_CONFIG_DIR env var', () => {
    process.env.WINDSURF_CONFIG_DIR = '~/custom-windsurf';
    const result = getGlobalConfigDir('windsurf');
    assert.strictEqual(result, path.join(os.homedir(), 'custom-windsurf'));
  });

  test('explicit dir takes priority over WINDSURF_CONFIG_DIR', () => {
    process.env.WINDSURF_CONFIG_DIR = '~/from-env';
    const result = getGlobalConfigDir('windsurf', '/explicit/path');
    assert.strictEqual(result, '/explicit/path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalConfigDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalConfigDir('codex'), path.join(os.homedir(), '.codex'));
  });
});
