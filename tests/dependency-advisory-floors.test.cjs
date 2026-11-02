'use strict';

// Regression test for #5840 (Dependabot alerts #46 and #45).
//
// The lockfile pinned re2js at 2.8.6 and @hono/node-server at 2.0.11, both below
// the patched versions the advisories require. This test reads the committed
// package-lock.json and fails if either package resolves below its patched
// version, so the pins cannot regress silently.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCK = path.join(__dirname, '..', 'package-lock.json');

// Floors come from the advisories: alert #46 (re2js) and alert #45 (@hono/node-server).
const FLOORS = [
  { pkg: 'node_modules/re2js', floor: '2.8.7', alert: '#46' },
  { pkg: 'node_modules/@hono/node-server', floor: '2.1.3', alert: '#45' },
];

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function lockedVersion(lock, pkg) {
  const entry = lock.packages && lock.packages[pkg];
  assert.ok(entry, `package-lock.json has no entry for ${pkg}`);
  return entry.version;
}

describe('dependency advisory floors (#5840)', () => {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));

  for (const { pkg, floor, alert } of FLOORS) {
    test(`${pkg} resolves at or above its patched version ${floor} (alert ${alert})`, () => {
      const version = lockedVersion(lock, pkg);
      assert.ok(
        compareSemver(version, floor) >= 0,
        `${pkg} is locked at ${version}, below the patched ${floor} required by alert ${alert}`,
      );
    });
  }
});
