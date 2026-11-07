'use strict';

/**
 * Property-based test for the #5482 shell boundary in `milestone complete`.
 *
 * A command-exit-zero ship:pre gate sees ${PHASE_DIR} as data. Whatever characters the phase directory
 * name holds, the double-quoted placeholder must name that directory: the gate finds the OPEN_WORK file
 * inside it, exits 3, and no command hidden in the name runs.
 *
 * Property: for a phase dir `01-<s>` holding OPEN_WORK, the dry-run's would_refuse entry for phase 01 has
 * reason `predicate_blocked` and details.exitCode 3, and no file appears in the project root.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { writeGateCap, cleanEnv } = require('./helpers/ship-gate-fixture.cjs');

const ORDINARY = [...'abcXYZ019._-~ é\''];
// Characters that are shell syntax and legal in a file name on every platform (Windows forbids \ " * ? < > |).
const SHELL_SYNTAX = [...'$`;&()#['];

describe('ship:pre command gate treats the phase directory name as data (#5482)', () => {
  let tmpDir;
  let home;
  let rootEntries;

  before(() => {
    tmpDir = createTempProject();
    home = createTempDir('gsd-5482-prop-home-');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n\n**Status:** In progress\n');
    writeGateCap(home, { command: 'test ! -f "${PHASE_DIR}/OPEN_WORK" || exit 3' });
    rootEntries = fs.readdirSync(tmpDir).sort();
  });
  after(() => { cleanup(tmpDir); cleanup(home); });

  // The would_refuse entry for phase 01 of a phase dir named `name`; mkdirSync throws when the file system cannot hold the name.
  function entryFor(name) {
    const dir = path.join(tmpDir, '.planning', 'phases', name);
    fs.mkdirSync(dir);
    try {
      fs.writeFileSync(path.join(dir, 'OPEN_WORK'), '');
      const r = runGsdTools('milestone complete v1.0 --name MVP --dry-run', tmpDir, cleanEnv(home));
      assert.equal(r.success, true, r.error);
      const out = JSON.parse(r.output);
      assert.ok(Array.isArray(out.would_refuse), `dry-run JSON lacks would_refuse: ${r.output}`);
      const entry = out.would_refuse.find((b) => b.phase === '01');
      assert.ok(entry, `phase 01 must be gated: ${r.output}`);
      return entry;
    } finally {
      cleanup(dir);
    }
  }

  test('property: any phase directory name is data, so the gate runs on it and nothing else runs', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...ORDINARY, ...SHELL_SYNTAX), minLength: 1, maxLength: 12 }), (s) => {
        const entry = entryFor(`01-${s}`);
        assert.equal(entry.reason, 'predicate_blocked', `01-${s} must run the gate: ${JSON.stringify(entry)}`);
        assert.equal(entry.details.exitCode, 3, `01-${s}`);
        assert.deepEqual(fs.readdirSync(tmpDir).sort(), rootEntries, 'no file may appear in the project root');
      }),
      { numRuns: 15 },
    );
  });
});
