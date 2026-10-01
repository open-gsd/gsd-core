'use strict';

/**
 * #5170 review fix (ADR-5057 §4): the static frontend-evidence probe reads typed evidence.
 *
 * `ui-plan-gate` blocks only when a vocabulary match is corroborated by static frontend evidence in the
 * repository (`block = frontend && hasFrontendEvidence && !hasUiSpec`). The probe used to swallow every
 * read failure into `false`: an unreadable `package.json`, a directory that could not be listed or a
 * native source file that could not be opened all read as "no evidence", so the gate passed over a tree it
 * had not looked at. The probe now returns `found` / `none` / `unreadable`, and the gate reports an
 * unreadable probe (when it could flip the verdict) as outcome `unreadable`.
 *
 * Failures are injected by monkeypatching the fs method in-process and restoring it in `finally` (never a
 * chmod, which a root process ignores). Each failing case has a no-fault control.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempProject, cleanup } = require('./helpers.cjs');
const { withFsFailure } = require('./helpers/fs-failure.cjs');
const { readStaticFrontendEvidence, hasStaticFrontendEvidence } = require('../gsd-core/bin/lib/ui-frontend-evidence.cjs');
const { evaluateUiPlanGate } = require('../gsd-core/bin/lib/gate-ui-plan.cjs');

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function project() {
  const dir = createTempProject('gsd-ui-evidence-');
  dirs.push(dir);
  return dir;
}

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const endsWith = (suffix) => (p) => p.endsWith(suffix);

describe('readStaticFrontendEvidence: found / none / unreadable', () => {
  test('an empty tree is none (examined, nothing found)', () => {
    assert.deepEqual(readStaticFrontendEvidence(project()), { kind: 'none' });
  });

  test('a UI-framework dependency is found; the boolean projection agrees', () => {
    const dir = project();
    write(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
    assert.equal(readStaticFrontendEvidence(dir).kind, 'found');
    assert.equal(hasStaticFrontendEvidence(dir), true);
  });

  test('a package.json that exists but cannot be read is unreadable, never "no dependency"', () => {
    const dir = project();
    write(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
    const evidence = withFsFailure('readFileSync', endsWith('package.json'), 'EACCES', () => readStaticFrontendEvidence(dir));
    assert.equal(evidence.kind, 'unreadable');
    assert.equal(evidence.reason, 'EACCES');
    assert.equal(withFsFailure('readFileSync', endsWith('package.json'), 'EACCES', () => hasStaticFrontendEvidence(dir)), false);
  });

  test('a package.json that is not valid JSON is unreadable (exists, could not be parsed)', () => {
    const dir = project();
    write(dir, 'package.json', '{ not json');
    assert.equal(readStaticFrontendEvidence(dir).kind, 'unreadable');
  });

  test('a directory that cannot be listed is unreadable when nothing affirmative was found', () => {
    const dir = project();
    write(dir, 'locked/readme.md', 'x');
    const evidence = withFsFailure('readdirSync', endsWith(`${path.sep}locked`), 'EACCES', () => readStaticFrontendEvidence(dir));
    assert.equal(evidence.kind, 'unreadable');
    assert.equal(evidence.reason, 'EACCES');
  });

  test('a native source file that cannot be opened is unreadable', () => {
    const dir = project();
    write(dir, 'App/App.swift', 'import SwiftUI\n');
    const evidence = withFsFailure('openSync', endsWith('App.swift'), 'EIO', () => readStaticFrontendEvidence(dir));
    assert.equal(evidence.kind, 'unreadable');
    assert.equal(evidence.reason, 'EIO');
    assert.equal(readStaticFrontendEvidence(dir).kind, 'found', 'control: openable, the SwiftUI import is evidence');
  });

  test('affirmative evidence wins over a read failure elsewhere', () => {
    const dir = project();
    write(dir, 'src/App.tsx', 'export const A = 1;\n');
    write(dir, 'locked/readme.md', 'x');
    const evidence = withFsFailure('readdirSync', endsWith(`${path.sep}locked`), 'EACCES', () => readStaticFrontendEvidence(dir));
    assert.equal(evidence.kind, 'found');
  });

  test('an absent or vanished directory is not a read failure (control)', () => {
    const dir = project();
    write(dir, 'docs/readme.md', 'x');
    const evidence = withFsFailure('readdirSync', endsWith(`${path.sep}docs`), 'ENOENT', () => readStaticFrontendEvidence(dir));
    assert.equal(evidence.kind, 'none');
  });

  test('property: found if the manifest or a readable component file says so, else unreadable exactly when something could not be read (seeded)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (reactDep, componentFile, manifestFails, dirFails) => {
        const dir = createTempProject('gsd-ui-evidence-prop-');
        try {
          write(dir, 'package.json', reactDep ? '{"dependencies":{"react":"^18.0.0"}}' : '{"name":"x"}');
          if (componentFile) write(dir, 'src/App.tsx', 'export const A = 1;\n');
          write(dir, 'locked/readme.md', 'x');
          const evidence = withFsFailure('readFileSync', (p) => manifestFails && p.endsWith('package.json'), 'EACCES', () => withFsFailure(
            'readdirSync', (p) => dirFails && p.endsWith(`${path.sep}locked`), 'EACCES', () => readStaticFrontendEvidence(dir),
          ));
          const manifestSays = reactDep && !manifestFails;
          const expected = manifestSays || componentFile ? 'found' : (manifestFails || dirFails ? 'unreadable' : 'none');
          return evidence.kind === expected;
        } finally {
          cleanup(dir);
        }
      }),
      { seed: 5170, numRuns: 60 },
    );
  });
});

describe('ui-plan-gate reports unreadable frontend evidence as outcome unreadable (never a pass over a tree it could not look at)', () => {
  const ROADMAP = ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the dashboard UI for operators', ''].join('\n');

  function frontendProject({ uiSpec }) {
    const dir = project();
    write(dir, '.planning/ROADMAP.md', ROADMAP);
    write(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
    write(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
    if (uiSpec) write(dir, '.planning/phases/01-dashboard/01-UI-SPEC.md', '# spec\n');
    return dir;
  }
  const failManifest = (body) => withFsFailure('readFileSync', endsWith('package.json'), 'EACCES', body);

  test('a frontend phase, no UI-SPEC, unreadable package.json -> unreadable (block policy kept: false)', () => {
    const dir = frontendProject({ uiSpec: false });
    const verdict = failManifest(() => evaluateUiPlanGate({ projectDir: dir, args: ['1'] }));
    assert.equal(verdict.outcome, 'unreadable');
    assert.equal(verdict.payload.hasFrontendEvidence, false);
    assert.equal(verdict.payload.block, false);
    assert.match(verdict.payload.readError, /static frontend evidence could not be read \(EACCES\)/);
  });

  test('control: the same project with a readable manifest blocks on the evidence it found', () => {
    const verdict = evaluateUiPlanGate({ projectDir: frontendProject({ uiSpec: false }), args: ['1'] });
    assert.equal(verdict.outcome, 'block');
    assert.equal(verdict.payload.hasFrontendEvidence, true);
  });

  test('a UI-SPEC present: unreadable evidence cannot flip the verdict, so it is a pass', () => {
    const dir = frontendProject({ uiSpec: true });
    const verdict = failManifest(() => evaluateUiPlanGate({ projectDir: dir, args: ['1'] }));
    assert.equal(verdict.outcome, 'pass');
    assert.equal(verdict.payload.readError, undefined);
  });

  test('not a frontend phase: the probe is never run, so a manifest failure is irrelevant', () => {
    const dir = project();
    write(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Database migration', '**Goal**: Move the tables', ''].join('\n'));
    write(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
    write(dir, '.planning/phases/01-db/01-01-PLAN.md', '# p\n');
    const verdict = failManifest(() => evaluateUiPlanGate({ projectDir: dir, args: ['1'] }));
    assert.equal(verdict.outcome, 'pass');
  });
});
