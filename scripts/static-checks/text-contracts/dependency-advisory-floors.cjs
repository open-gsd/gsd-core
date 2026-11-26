'use strict';

// The committed lockfile resolves each advisory-bound package at or above its patched version (#5840, Dependabot
// alerts #46 and #45), so a pin cannot regress silently. Was tests/dependency-advisory-floors.test.cjs.

// Floors come from the advisories: alert #46 (re2js) and alert #45 (@hono/node-server).
const FLOORS = [
  { pkg: 'node_modules/re2js', floor: '2.8.7', alert: '#46' },
  { pkg: 'node_modules/@hono/node-server', floor: '2.1.3', alert: '#45' },
];

function compareSemver(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

module.exports = {
  compareSemver, // exported for the property test in tests/text-contracts.test.cjs
  id: 'dependency-advisory-floors',
  issue: '#5840',
  check(ctx) {
    const lock = ctx.doc('package-lock.json');
    for (const { pkg, floor, alert } of FLOORS) {
      lock.satisfies((text) => {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          return `package-lock.json is not valid JSON: ${err.message}`;
        }
        const entry = parsed.packages && parsed.packages[pkg];
        if (!entry) return `package-lock.json has no entry for ${pkg}`;
        return compareSemver(String(entry.version), floor) >= 0 || `${pkg} is locked at ${entry.version}, below the patched ${floor} required by alert ${alert}`;
      }, `${pkg} must resolve at or above its patched version ${floor} (alert ${alert})`);
    }
  },
};
