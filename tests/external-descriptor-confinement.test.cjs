'use strict';
/**
 * Tests for the external-descriptor trust gate (ADR-1239 Phase C-2, #1681).
 * Pins: confined passes; escapes (.. / absolute) rejected fail-closed; missing
 * layout passes; the configHome-equals-root edge; non-string destSubpath skipped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  isPathConfined,
  assertDescriptorConfined,
} = require('../gsd-core/bin/lib/external-descriptor-trust.cjs');

test('isPathConfined: confined paths are true, escapes are false', () => {
  const root = path.join('/home', 'me', '.gsd');
  assert.ok(isPathConfined('skills', root), 'simple subdir is confined');
  assert.ok(isPathConfined('skills/gsd-plan.md', root), 'nested subdir is confined');
  assert.ok(isPathConfined('.', root), 'root itself is confined');
  assert.ok(!isPathConfined('../etc/passwd', root), 'parent escape is NOT confined');
  assert.ok(!isPathConfined('../../etc', root), 'multi-level escape is NOT confined');
  assert.ok(!isPathConfined('/etc/passwd', root), 'absolute path outside root is NOT confined');
  assert.ok(!isPathConfined('', root), 'empty target is NOT confined');
  assert.ok(!isPathConfined('skills', ''), 'empty root is NOT confined');
});

test('assertDescriptorConfined: a benign descriptor (all destSubpaths under configHome) passes', () => {
  const desc = {
    id: 'community-host',
    runtime: { artifactLayout: {
      global: [{ destSubpath: 'skills' }, { destSubpath: 'agents' }],
      local: [{ destSubpath: 'commands' }],
    } },
  };
  assert.doesNotThrow(() => assertDescriptorConfined(desc, '/home/me/.community'));
});

test('assertDescriptorConfined: a global destSubpath escape is rejected fail-closed', () => {
  const desc = {
    id: 'malicious-host',
    runtime: { artifactLayout: { global: [{ destSubpath: '../../../etc/passwd' }] } },
  };
  assert.throws(
    () => assertDescriptorConfined(desc, '/home/me/.gsd'),
    /malicious-host.*unconfined global destSubpath.*fail-closed/,
    'an escaping global destSubpath must be rejected with a fail-closed error naming the descriptor',
  );
});

test('assertDescriptorConfined: a local destSubpath escape is rejected fail-closed', () => {
  const desc = {
    id: 'sneaky-host',
    runtime: { artifactLayout: { local: [{ destSubpath: '../../.ssh/authorized_keys' }] } },
  };
  assert.throws(
    () => assertDescriptorConfined(desc, '/home/me/.gsd'),
    /sneaky-host.*unconfined local destSubpath/,
    'an escaping local destSubpath must be rejected',
  );
});

test('assertDescriptorConfined: an absolute destSubpath outside configHome is rejected', () => {
  const desc = {
    id: 'abs-host',
    runtime: { artifactLayout: { global: [{ destSubpath: '/etc/cron.d/evil' }] } },
  };
  assert.throws(() => assertDescriptorConfined(desc, '/home/me/.gsd'), /unconfined global destSubpath/);
});

test('assertDescriptorConfined: a descriptor with no artifact layout passes (nothing to confine)', () => {
  assert.doesNotThrow(() => assertDescriptorConfined({ id: 'bare', runtime: {} }, '/home/me/.gsd'));
  assert.doesNotThrow(() => assertDescriptorConfined({ id: 'noruntime' }, '/home/me/.gsd'));
  assert.doesNotThrow(() => assertDescriptorConfined({}, '/home/me/.gsd'));
  assert.doesNotThrow(() => assertDescriptorConfined(null, '/home/me/.gsd'));
});

test('assertDescriptorConfined: non-string / empty destSubpath entries are skipped (not flagged)', () => {
  const desc = {
    id: 'mixed',
    runtime: { artifactLayout: { global: [{ destSubpath: 'skills' }, { destSubpath: '' }, { destSubpath: null }, {}, { destSubpath: 'agents' }] } },
  };
  assert.doesNotThrow(() => assertDescriptorConfined(desc, '/home/me/.x'), 'valid entries pass; invalid entries skipped');
});
