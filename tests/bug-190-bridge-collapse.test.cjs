'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('bridge collapse removes cjs-sdk-bridge and runtime-bridge-sync seam', () => {
  const bridgePath = path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'cjs-sdk-bridge.cjs');
  const runtimeSyncDir = path.join(ROOT, 'sdk', 'src', 'runtime-bridge-sync');

  assert.equal(fs.existsSync(bridgePath), false, 'cjs-sdk-bridge.cjs must be removed');
  assert.equal(fs.existsSync(runtimeSyncDir), false, 'sdk/src/runtime-bridge-sync must be removed');

  const routers = [
    'get-shit-done/bin/lib/init-command-router.cjs',
    'get-shit-done/bin/lib/roadmap-command-router.cjs',
    'get-shit-done/bin/lib/state-command-router.cjs',
    'get-shit-done/bin/lib/validate-command-router.cjs',
    'get-shit-done/bin/lib/verify-command-router.cjs',
    'get-shit-done/bin/lib/phases-command-router.cjs',
  ];

  for (const rel of routers) {
    const src = read(rel);
    assert.equal(
      src.includes('cjs-sdk-bridge.cjs'),
      false,
      `${rel} must not import cjs-sdk-bridge.cjs`,
    );
  }

  const sdkPkg = JSON.parse(read('sdk/package.json'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(sdkPkg.dependencies || {}, 'synckit'),
    false,
    'sdk/package.json must not include synckit',
  );
});
