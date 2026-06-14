'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const INSTALL_PATH = path.join(ROOT, 'bin', 'install.js');
const ACTIVE_GUIDANCE_PATHS = [
  'docs/contributing/bootstrap.md',
];

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
}

test('enhancement #191: sdk package artifacts are removed from repository layout', () => {
  const sdkDir = path.join(ROOT, 'sdk');
  const shimPath = path.join(ROOT, 'bin', 'gsd-sdk.js');

  assert.equal(fs.existsSync(sdkDir), false, 'sdk/ directory must be deleted');
  assert.equal(fs.existsSync(shimPath), false, 'bin/gsd-sdk.js must be deleted');
});

test('enhancement #191: published package no longer exposes gsd-sdk artifacts', () => {
  const pkg = readPackageJson();

  assert.equal(Object.prototype.hasOwnProperty.call(pkg.bin || {}, 'gsd-sdk'), false,
    'package.json bin must not expose gsd-sdk');
  assert.equal(pkg.bin && pkg.bin['gsd-tools'], 'gsd-core/bin/gsd-tools.cjs',
    'package.json bin.gsd-tools must point to gsd-core/bin/gsd-tools.cjs');

  const publishedFiles = Array.isArray(pkg.files) ? pkg.files : [];
  const hasSdkPublishedPaths = publishedFiles.some((entry) => String(entry).startsWith('sdk'));
  assert.equal(hasSdkPublishedPaths, false,
    'package.json files must not include sdk artifacts');
});

test('enhancement #191: installer does not maintain gsd-sdk shim compatibility path', () => {
  const installJs = fs.readFileSync(INSTALL_PATH, 'utf8');

  assert.equal(/\b--sdk\b/.test(installJs), false,
    'bin/install.js must not expose --sdk flag');
  assert.equal(/\b--no-sdk\b/.test(installJs), false,
    'bin/install.js must not expose --no-sdk flag');
  assert.equal(/installSdkIfNeeded\(\{/.test(installJs), false,
    'bin/install.js must not run installSdkIfNeeded during installation');
});

test('enhancement #191: active contributor guidance does not reference retired SDK build steps', () => {
  for (const relPath of ACTIVE_GUIDANCE_PATHS) {
    const body = fs.readFileSync(path.join(ROOT, relPath), 'utf8');

    assert.equal(
      /\bbuild:sdk\b|\bcd sdk\b|\bsdk\/dist\b|\bsdk\/src\b/.test(body),
      false,
      `${relPath} must not direct contributors or agents to use the retired SDK package workflow`,
    );
  }
});
