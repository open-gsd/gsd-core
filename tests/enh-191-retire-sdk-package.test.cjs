'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const INSTALL_PATH = path.join(ROOT, 'bin', 'install.js');

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
  assert.equal(pkg.bin && pkg.bin['gsd-tools'], 'get-shit-done/bin/gsd-tools.cjs',
    'package.json bin.gsd-tools must point to get-shit-done/bin/gsd-tools.cjs');

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

  process.env.GSD_TEST_MODE = '1';
  const install = require(INSTALL_PATH);
  for (const name of [
    'installSdkIfNeeded',
    'buildSdkFailFastReport',
    'renderSdkFailFastReport',
    'classifySdkInstall',
    'readGsdSdkVersion',
    'buildGsdSdkVersionMismatchReport',
    'renderGsdSdkVersionMismatchReport',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(install, name),
      false,
      `bin/install.js must not export retired SDK helper ${name}`,
    );
  }
});
