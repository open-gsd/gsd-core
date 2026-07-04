'use strict';
/**
 * Integration test: loadRegistry wires the external-descriptor trust gate
 * (ADR-1239 Phase C-2 / #1681 slice 2). When `configHome` is supplied, an
 * installed overlay whose declared destSubpath escapes it is rejected
 * (skip + confinement reason) and NOT composed; a confined overlay composes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');
const { loadRegistry } = require('../gsd-core/bin/lib/capability-loader.cjs');

const HOST = '1.6.0';

function featureCap(id, extra) {
  return {
    id, role: 'feature', version: '1.0.0', title: id, description: 'overlay cap',
    tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    ...extra,
  };
}

// Build a temp GSD home with .gsd/capabilities/<id>/capability.json per cap.
function makeOverlayHome(caps) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-trust-'));
  for (const cap of caps) {
    const dir = path.join(home, '.gsd', 'capabilities', cap.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return home;
}

test('loadRegistry configHome confinement: escaping overlay is skipped with a confinement reason', () => {
  const home = makeOverlayHome([
    featureCap('confined-host', { runtime: { artifactLayout: { global: [{ destSubpath: 'skills' }] } } }),
    featureCap('escape-host', { runtime: { artifactLayout: { global: [{ destSubpath: '../../../etc/passwd' }] } } }),
  ]);
  try {
    const reg = loadRegistry({
      includeInstalled: true, gsdHome: home, cwd: home, hostVersion: HOST,
      configHome: path.join(home, '.target'),
    });
    const overlayIds = Object.keys(reg.capabilities || {}).filter((id) => id === 'confined-host' || id === 'escape-host');
    assert.ok(overlayIds.includes('confined-host'), 'confined overlay must be composed');
    assert.ok(!overlayIds.includes('escape-host'), 'escaping overlay must NOT be composed');
    const skips = (reg._overlay && reg._overlay.warnings) || [];
    const confinementSkip = skips.find((s) => /confinement/.test(s.reason || ''));
    assert.ok(confinementSkip, `an overlay must be skipped with a confinement reason; warnings=${JSON.stringify(skips)}`);
    assert.match(confinementSkip.reason, /escape-host/, 'the confinement skip must name the escaping descriptor');
  } finally {
    cleanup(home);
  }
});

test('loadRegistry configHome confinement: omitted configHome = no load-time check (backward-compatible; relies on install-time gate)', () => {
  // Same escaping overlay, but no configHome passed → it is NOT rejected by the load-time gate.
  const home = makeOverlayHome([
    featureCap('escape-host', { runtime: { artifactLayout: { global: [{ destSubpath: '../../../etc' }] } } }),
  ]);
  try {
    const reg = loadRegistry({ includeInstalled: true, gsdHome: home, cwd: home, hostVersion: HOST });
    const warnings = (reg._overlay && reg._overlay.warnings) || [];
    const confinementSkip = warnings.find((s) => /confinement/.test(s.reason || ''));
    assert.ok(!confinementSkip, 'no configHome → no load-time confinement check (backward-compatible)');
  } finally {
    cleanup(home);
  }
});
