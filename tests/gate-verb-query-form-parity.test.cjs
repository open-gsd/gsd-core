'use strict';

/**
 * #5170 review: the form agents use — `gsd_run query verify.<sub>` / `query phase.uat-passed` — projects the
 * same declared exit status as the direct form `verify <sub>` / `phase uat-passed`, and prints the same
 * verdict JSON. The agent files (`gsd-verifier`, `gsd-plan-checker`, `gsd-planner`) call the query form and
 * branch on `$?`, so a divergence between the two forms would turn a verdict into a command failure (or the
 * reverse) for exactly the callers this phase migrated.
 *
 * One table drives both forms through every status a gate verb can declare: 0 (a delivered answer), 1 (a
 * negative verdict), 66 (a genuinely empty scope) and 69 (could not look).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { runTools } = require('./helpers/gsd-tools-cli.cjs');

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function fixture() {
  const dir = createTempGitProject('gsd-query-parity-');
  dirs.push(dir);
  const w = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  w('.planning/phases/01-x/01-01-PLAN.md', '---\nphase: 1\nplan: 1\nwave: 1\nmust_haves:\n  artifacts:\n    - path: nope.txt\n      provides: x\n---\n# p\n');
  w('.planning/phases/01-x/01-CONTEXT.md', '# c\n');
  return dir;
}

const PLAN = '.planning/phases/01-x/01-01-PLAN.md';

// [direct argv, query argv, declared exit]
const TABLE = [
  [['verify', 'artifacts', PLAN], ['query', 'verify.artifacts', PLAN], 1],
  [['verify', 'artifacts', '.planning/phases/01-x/missing.md'], ['query', 'verify.artifacts', '.planning/phases/01-x/missing.md'], 69],
  [['verify', 'plan-structure', PLAN], ['query', 'verify.plan-structure', PLAN], 1],
  [['verify', 'plan-structure', 'missing.md'], ['query', 'verify.plan-structure', 'missing.md'], 69],
  [['verify', 'key-links', PLAN], ['query', 'verify.key-links', PLAN], 66],
  [['verify', 'phase-completeness', '1'], ['query', 'verify.phase-completeness', '1'], 1],
  [['verify', 'phase-completeness', '99'], ['query', 'verify.phase-completeness', '99'], 69],
  [['verify', 'references', 'missing.md'], ['query', 'verify.references', 'missing.md'], 69],
  [['verify', 'commits', 'deadbeef'], ['query', 'verify.commits', 'deadbeef'], 1],
  [['verify', 'context-drift', '99'], ['query', 'verify.context-drift', '99'], 69],
  [['verify', 'schema-drift', '99'], ['query', 'verify.schema-drift', '99'], 69],
  [['verify', 'codebase-drift'], ['query', 'verify.codebase-drift'], 0],
  [['phase', 'uat-passed', '1'], ['query', 'phase.uat-passed', '1'], 1],
];

describe('the query form of a gate verb declares the same exit and prints the same verdict as the direct form', () => {
  for (const [direct, query, expected] of TABLE) {
    test(`${direct.join(' ')} <-> ${query.join(' ')}: exit ${expected}`, () => {
      const dir = fixture();
      const a = runTools(direct, dir);
      const b = runTools(query, dir);
      assert.equal(a.exitCode, expected, `direct form: ${a.stdout} ${a.stderr}`);
      assert.equal(b.exitCode, expected, `query form: ${b.stdout} ${b.stderr}`);
      assert.deepEqual(JSON.parse(b.stdout), JSON.parse(a.stdout), 'the verdict JSON is the same');
    });
  }

  test('the table covers every declared status (the parity is not asserted over a single exit code)', () => {
    assert.deepEqual([...new Set(TABLE.map((row) => row[2]))].sort((x, y) => x - y), [0, 1, 66, 69]);
  });
});
