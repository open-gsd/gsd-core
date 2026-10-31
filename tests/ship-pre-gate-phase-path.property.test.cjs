'use strict';

/**
 * Property-based test for the #5482 shell guard in `milestone complete`.
 *
 * A command-exit-zero ship:pre gate interpolates ${PHASE_DIR} and ${PHASE_NUMBER} textually into
 * `sh -c`, so a phase directory whose name holds a shell-significant character must never reach the
 * shell, and every other name must run the gate.
 *
 * Property: for a phase dir `01-<s>`, the dry-run's would_refuse entry for phase 01 reads
 * `gate not run` exactly when `s` holds a shell-significant character, and `command exited 3`
 * otherwise; no file appears in the project root. Boundary: no length cap (200 and 201 characters).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { writeGateCap, cleanEnv } = require('./helpers/ship-gate-fixture.cjs');

const SAFE = [...'abcXYZ019._-~ é\''];
const HOSTILE = [...'$`;&|<>()#*?['];

describe('ship:pre command gate refuses shell-significant phase directory names (#5482)', () => {
  let tmpDir;
  let home;
  let rootEntries;

  before(() => {
    tmpDir = createTempProject();
    home = createTempDir('gsd-5482-prop-home-');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n\n**Status:** In progress\n');
    writeGateCap(home, { command: 'exit 3' });
    rootEntries = fs.readdirSync(tmpDir).sort();
  });
  after(() => { cleanup(tmpDir); cleanup(home); });

  // Phase 01's gate_message for a phase dir named `name`, or null when the file system cannot hold that name.
  function gateMessageFor(name) {
    const dir = path.join(tmpDir, '.planning', 'phases', name);
    try {
      fs.mkdirSync(dir);
    } catch {
      return null;
    }
    try {
      const r = runGsdTools('milestone complete v1.0 --name MVP --dry-run', tmpDir, cleanEnv(home));
      assert.equal(r.success, true, r.error);
      const entry = JSON.parse(r.output).would_refuse.find((b) => b.phase === '01');
      assert.ok(entry, `phase 01 must be gated: ${r.output}`);
      return entry.gate_message;
    } finally {
      cleanup(dir);
    }
  }

  test('property: gate not run iff the name holds a shell-significant character; otherwise the gate runs', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...SAFE, ...HOSTILE), minLength: 1, maxLength: 12 }), (s) => {
        const message = gateMessageFor(`01-${s}`);
        if (message === null) return;
        const hostile = [...s].some((c) => HOSTILE.includes(c));
        if (hostile) assert.match(message, /gate not run/, `01-${s} must not reach the shell`);
        else assert.match(message, /^command exited 3/, `01-${s} must run the gate`);
        assert.deepEqual(fs.readdirSync(tmpDir).sort(), rootEntries, 'no file may appear in the project root');
      }),
      { numRuns: 15 },
    );
  });

  for (const total of [200, 201]) {
    test(`boundary: a clean ${total}-character directory name runs the gate (no length cap)`, () => {
      const message = gateMessageFor('01-'.padEnd(total, 'a'));
      assert.ok(message === null || message.startsWith('command exited 3'), message);
    });
  }
});
