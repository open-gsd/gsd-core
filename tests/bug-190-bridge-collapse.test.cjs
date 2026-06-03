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
  const bridgePath = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'cjs-sdk-bridge.cjs');
  const sdkDir = path.join(ROOT, 'sdk');

  assert.equal(fs.existsSync(bridgePath), false, 'cjs-sdk-bridge.cjs must be removed');
  assert.equal(fs.existsSync(sdkDir), false, 'sdk directory must be removed');

  const routers = [
    'gsd-core/bin/lib/init-command-router.cjs',
    'gsd-core/bin/lib/roadmap-command-router.cjs',
    'gsd-core/bin/lib/state-command-router.cjs',
    'gsd-core/bin/lib/validate-command-router.cjs',
    'gsd-core/bin/lib/verify-command-router.cjs',
    'gsd-core/bin/lib/phases-command-router.cjs',
  ];

  for (const rel of routers) {
    const src = read(rel);
    assert.equal(
      src.includes('cjs-sdk-bridge.cjs'),
      false,
      `${rel} must not import cjs-sdk-bridge.cjs`,
    );
  }

  const rootPkg = JSON.parse(read('package.json'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(rootPkg.dependencies || {}, 'synckit'),
    false,
    'package.json must not include synckit',
  );
});
