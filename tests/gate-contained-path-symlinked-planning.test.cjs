'use strict';

/**
 * #5474: the gate path-containment helper (`resolveContainedPath`) must accept a phase directory
 * reached through the project's OWN symlinked, out-of-repo `.planning`, and nothing wider.
 * Covers both gates the issue names (check decision-coverage-plan, check gap-analysis.plan-post) in
 * depth, plus one accept and one refuse case for the two callers that take the path through a flag
 * (check verify-command-paths --dir, check predicate --phase-dir). The other helper callers share
 * the same resolveContainedPath call, which these cases exercise.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const { exitCodeFor } = require('../gsd-core/bin/lib/exit-code-registry.cjs');

const REL_PHASE = path.join('.planning', 'phases', '01-demo');

function seedPhase(phaseDir) {
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'CONTEXT.md'),
    '<decisions>\n- **D-01:** Use PostgreSQL for the primary datastore layer\n</decisions>\n',
  );
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '<objective>Unrelated work REQ-01</objective>\n');
}

function decisionGate(proj, phaseArg, env) {
  return runGsdTools(['--json-errors', 'check', 'decision-coverage-plan', phaseArg, '--context', path.join(phaseArg, 'CONTEXT.md')], proj, env);
}
function gapGate(proj, phaseArg, env) {
  return runGsdTools(['--json-errors', 'check', 'gap-analysis.plan-post', phaseArg, 'REQ-01,REQ-02', '--raw'], proj, env);
}
// A concrete verdict field per gate, so a degradation shared by the control and the symlinked run
// still fails: the seeded phase leaves D-01 uncovered.
function assertDecisionVerdict(output) {
  const v = JSON.parse(output);
  assert.equal(v.passed, false);
  assert.deepEqual(v.uncovered.map((d) => d.id), ['D-01']);
}
function assertGapVerdict(output) {
  const v = JSON.parse(output);
  // REQ-01, REQ-02 and D-01 are all uncovered; the gate reports, it does not block.
  assert.deepEqual(v.counts, { total: 3, covered: 0, uncovered: 3 });
  assert.equal(v.block, false);
}
const GATES = [
  ['decision-coverage-plan', decisionGate, assertDecisionVerdict],
  ['gap-analysis.plan-post', gapGate, assertGapVerdict],
];

describe('#5474: gate containment with a symlinked out-of-repo .planning', () => {
  let root, proj, store, realProj;

  beforeEach(() => {
    root = fs.realpathSync(createTempDir('gsd-5474-'));
    proj = path.join(root, 'proj');
    store = path.join(root, 'store');
    fs.mkdirSync(proj);
    fs.mkdirSync(store);
    seedPhase(path.join(store, 'phases', '01-demo'));
    fs.symlinkSync(store, path.join(proj, '.planning'), process.platform === 'win32' ? 'junction' : 'dir');
    // control: identical content under a real .planning directory
    realProj = path.join(root, 'real');
    seedPhase(path.join(realProj, REL_PHASE));
  });

  afterEach(() => cleanup(root));

  for (const [name, gate, assertVerdict] of GATES) {
    test(`${name}: relative and real absolute store paths give the real-directory verdict`, () => {
      const control = gate(realProj, REL_PHASE);
      assert.ok(control.success, `control failed: ${control.error}`);
      for (const arg of [REL_PHASE, path.join(store, 'phases', '01-demo')]) {
        const r = gate(proj, arg);
        assert.ok(r.success, `${arg} refused: ${r.error}`);
        assert.deepEqual(JSON.parse(r.output), JSON.parse(control.output));
        assertVerdict(r.output);
      }
    });

    // Seeds the escape cases and returns the arguments that must be refused.
    function escapeArgs() {
      const outside = path.join(root, 'outside');
      seedPhase(outside);
      fs.symlinkSync(outside, path.join(store, 'phases', 'link-out'), process.platform === 'win32' ? 'junction' : 'dir');
      const evil = path.join(root, 'store-evil');
      seedPhase(evil);
      const store2 = path.join(root, 'store2'); // shares the store's name prefix with no separator
      seedPhase(store2);
      // The `..` case collapses lexically (path.join) before any symlink is crossed, so it guards the
      // lexical step and is refused on base too; the in-store `link-out` symlink is the case that
      // exercises the second root's realpath containment.
      return [path.join('.planning', 'phases', 'link-out'), outside, path.join('.planning', '..', '..', 'outside'), evil, store2];
    }
    function assertRefused(arg, r, label) {
      assert.equal(r.success, false, `${label}${arg} was accepted`);
      // --json-errors gives the typed refusal: exit 1 with reason ERROR_REASON.USAGE.
      assert.equal(r.exitCode, 1, `${label}${arg}: ${r.error}`);
      assert.equal(JSON.parse(r.error).reason, ERROR_REASON.USAGE, `${label}${arg}: ${r.error}`);
    }

    test(`${name}: still refuses an in-store symlink to outside, an outside absolute path, .. traversal and a prefix sibling`, () => {
      for (const arg of escapeArgs()) assertRefused(arg, gate(proj, arg), '');
    });

    // The second root is the project's own .planning (planningRoot), not the env-scoped planningDir:
    // GSD_WORKSTREAM / GSD_PROJECT narrow planningDir below .planning, which would refuse these paths.
    for (const [envName, scope] of [['GSD_WORKSTREAM', path.join('workstreams', 'ws')], ['GSD_PROJECT', 'ws']]) {
      test(`${name}: ${envName} set still accepts the phase under the symlinked store`, () => {
        fs.mkdirSync(path.join(store, scope), { recursive: true });
        const env = { [envName]: 'ws' };
        const control = gate(realProj, REL_PHASE);
        assert.ok(control.success, `control failed: ${control.error}`);
        for (const arg of [REL_PHASE, path.join(store, 'phases', '01-demo')]) {
          const r = gate(proj, arg, env);
          assert.ok(r.success, `${envName}=ws: ${arg} refused: ${r.error}`);
          assert.deepEqual(JSON.parse(r.output), JSON.parse(control.output));
          assertVerdict(r.output);
        }
      });

      test(`${name}: ${envName} set still refuses every escape`, () => {
        fs.mkdirSync(path.join(store, scope), { recursive: true });
        const env = { [envName]: 'ws' };
        for (const arg of escapeArgs()) assertRefused(arg, gate(proj, arg, env), `${envName}=ws: `);
      });
    }

    // Trust assumption, accepted by design (#5474 scope; see resolveContainedPath's JSDoc): the
    // project's own .planning link is trusted, so whatever it resolves to becomes a containment root,
    // even a broad directory. Pinned here so a change to that contract is a deliberate one.
    test(`${name}: a .planning linked to a broad directory makes paths under it contained (by design)`, () => {
      const broad = path.join(root, 'broad');
      const broadProj = path.join(root, 'broad-proj');
      fs.mkdirSync(broadProj);
      seedPhase(path.join(broad, 'phases', '01-demo'));
      const unrelated = path.join(broad, 'unrelated', 'dir');
      seedPhase(unrelated);
      fs.symlinkSync(broad, path.join(broadProj, '.planning'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = gate(broadProj, unrelated);
      assert.ok(r.success, `${unrelated} refused: ${r.error}`);
      assertVerdict(r.output);
      // ...and outside the link target is still refused
      assertRefused(store, gate(broadProj, store), 'broad: ');
    });

    test(`${name}: real .planning directory still refuses an outside path`, () => {
      const outside = path.join(root, 'outside');
      seedPhase(outside);
      assertRefused(outside, gate(realProj, outside), 'real .planning: ');
    });
  }

  test('verify-command-paths --dir: accepts a phase under the symlinked store and refuses one outside', () => {
    const r = runGsdTools(['check', 'verify-command-paths', '--dir', REL_PHASE, '--raw'], proj);
    assert.ok(r.success, `refused: ${r.error}`);
    assert.equal(JSON.parse(r.output).readError, null);
    const outside = path.join(root, 'outside');
    seedPhase(outside);
    // This probe degrades an escape to its unresolvable payload (exit UNAVAILABLE), not a usage error.
    const bad = runGsdTools(['check', 'verify-command-paths', '--dir', outside, '--raw'], proj);
    assert.equal(bad.success, false, 'outside --dir was accepted');
    assert.equal(bad.exitCode, exitCodeFor('UNAVAILABLE'), bad.error);
    const v = JSON.parse(bad.output);
    assert.equal(v.status, 'unresolvable');
    assert.deepEqual(v.commands, []);
  });

  test('predicate --phase-dir: evaluates a phase under the symlinked store and refuses one outside', () => {
    fs.writeFileSync(path.join(store, 'phases', '01-demo', 'SECURITY.md'), '---\nstatus: passed\n---\n# Security\n');
    const predicate = JSON.stringify({ kind: 'artifact-frontmatter-equals', artifact: 'SECURITY.md', field: 'status', equals: 'passed' });
    const r = runGsdTools(['check', 'predicate', '--predicate', predicate, '--phase-dir', REL_PHASE, '--raw'], proj);
    assert.ok(r.success, `refused: ${r.error}`);
    assert.equal(JSON.parse(r.output).block, false);
    const outside = path.join(root, 'outside');
    seedPhase(outside);
    const bad = runGsdTools(['--json-errors', 'check', 'predicate', '--predicate', predicate, '--phase-dir', outside, '--raw'], proj);
    assert.equal(bad.success, false, 'outside --phase-dir was accepted');
    assert.equal(bad.exitCode, 1, bad.error);
    assert.equal(JSON.parse(bad.error).reason, ERROR_REASON.USAGE, bad.error);
  });
});
