'use strict';

/**
 * #5275: `check tdd-review-checkpoint` reported `Pass` for a `type: tdd` plan whose `feat(...)` commit
 * came BEFORE its `test(...)` commit, because it only tested set membership of the commit kinds.
 * tdd.md says the review checks RED -> GREEN order. A GREEN counts only when it descends from a
 * RED commit (ancestry, never log position or commit date); a plan with GREEN before RED is a
 * violation with its own reason, distinct from a missing RED or GREEN.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const { evaluateTddReviewCheckpoint } = require('../gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs');
const { commitIsAncestor } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

function git(dir, env, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...env } },
  );
}

let commitCounter = 0;
/** A commit that touches a file of its own (the gate scopes `git log` to `-- .`). */
function commit(dir, message, env = {}) {
  const file = `c-${commitCounter++}.txt`;
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-m', message);
}

const plan = (id, { type = 'tdd', dependsOn } = {}) =>
  `---\nphase: 1\nplan: ${id}\ntype: ${type}\n${dependsOn ? `depends_on: [${dependsOn}]\n` : ''}---\n# Plan\n`;

function withProject(plans, build, fn) {
  const dir = createTempGitProject('gate-tdd-order-');
  try {
    for (const [name, content] of Object.entries(plans)) {
      const file = path.join(dir, '.planning', 'phases', '01-x', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    build(dir);
    const result = evaluateTddReviewCheckpoint({ projectDir: dir, args: ['1'] });
    assert.equal(result.failure, undefined, 'not a usage failure');
    return fn(result.payload);
  } finally {
    cleanup(dir);
  }
}

const ONE = { '01-01-PLAN.md': plan('1') };

describe('#5275 RED must precede GREEN by ancestry', () => {
  test('test then feat passes (unchanged)', () => {
    withProject(ONE, (d) => { commit(d, 'test(01-01): red'); commit(d, 'feat(01-01): green'); }, (out) => {
      assert.equal(out.violations, 0);
      assert.equal(out.rows[0].status, 'Pass');
    });
  });

  test('feat before test is a violation with its own reason, and blocks', () => {
    withProject(ONE, (d) => { commit(d, 'feat(01-01): green first'); commit(d, 'test(01-01): red later'); }, (out) => {
      assert.equal(out.violations, 1);
      assert.equal(out.block, true);
      const row = out.rows[0];
      assert.equal(row.status, 'FAIL');
      assert.equal(row.reason, 'green_before_red');
      assert.deepEqual(row.missing, [], 'both commits exist: nothing is missing, the order is wrong');
      assert.ok(
        out.table.includes('Plan 01-01 GREEN precedes RED: no feat(...) commit descends from a test(...) commit.'),
        out.table,
      );
      assert.ok(!out.table.includes('missing:'), 'an order violation is not reported as a missing commit');
    });
  });

  test('a missing RED or GREEN keeps its existing reason, distinct from the order violation', () => {
    withProject(ONE, (d) => { commit(d, 'test(01-01): red only'); }, (out) => {
      assert.equal(out.rows[0].reason, undefined, 'a missing commit is told by missing, not by a reason');
      assert.deepEqual(out.rows[0].missing, ['GREEN']);
    });
    withProject(ONE, (d) => { commit(d, 'feat(01-01): green only'); }, (out) => {
      assert.equal(out.rows[0].reason, undefined, 'a missing commit is told by missing, not by a reason');
      assert.deepEqual(out.rows[0].missing, ['RED']);
    });
  });

  test('several cycles: one GREEN after the earliest RED satisfies the plan', () => {
    withProject(ONE, (d) => {
      commit(d, 'feat(01-01): stray early green');
      commit(d, 'test(01-01): red');
      commit(d, 'feat(01-01): green');
    }, (out) => {
      assert.equal(out.violations, 0);
    });
    withProject(ONE, (d) => {
      commit(d, 'test(01-01): red 1'); commit(d, 'feat(01-01): green 1');
      commit(d, 'test(01-01): red 2'); commit(d, 'feat(01-01): green 2');
    }, (out) => {
      assert.equal(out.violations, 0);
    });
  });

  test('order is decided by ancestry, not by commit date', () => {
    // RED is the ancestor but carries a LATER date than its GREEN child: still in order.
    withProject(ONE, (d) => {
      commit(d, 'test(01-01): red', { GIT_AUTHOR_DATE: '2031-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2031-01-01T00:00:00Z' });
      commit(d, 'feat(01-01): green', { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' });
    }, (out) => {
      assert.equal(out.violations, 0, 'GREEN descends from RED even though it is dated earlier');
    });
    // GREEN is the ancestor but carries a LATER date: out of order.
    withProject(ONE, (d) => {
      commit(d, 'feat(01-01): green', { GIT_AUTHOR_DATE: '2031-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2031-01-01T00:00:00Z' });
      commit(d, 'test(01-01): red', { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' });
    }, (out) => {
      assert.equal(out.rows[0].reason, 'green_before_red');
    });
  });

  test('a worktree branch merged in the correct order still passes', () => {
    withProject(ONE, (d) => {
      commit(d, 'chore: base');
      git(d, {}, 'checkout', '-q', '-b', 'wt-red');
      commit(d, 'test(01-01): red on a worktree branch');
      git(d, {}, 'checkout', '-q', '-');
      git(d, {}, 'merge', '--no-ff', '-q', '-m', 'merge wt-red', 'wt-red');
      commit(d, 'feat(01-01): green after the merge');
    }, (out) => {
      assert.equal(out.violations, 0);
    });
  });

  test('a GREEN on a branch that never descends from the RED is not credited', () => {
    withProject(ONE, (d) => {
      commit(d, 'chore: base');
      git(d, {}, 'checkout', '-q', '-b', 'side');
      commit(d, 'feat(01-01): green on a side branch');
      git(d, {}, 'checkout', '-q', '-');
      commit(d, 'test(01-01): red on the main line');
      git(d, {}, 'merge', '--no-ff', '-q', '-m', 'merge side', 'side');
    }, (out) => {
      assert.equal(out.rows[0].reason, 'green_before_red');
    });
  });

  test('cross-plan GREEN (#4867) must also come after the RED', () => {
    const plans = {
      '01-01-PLAN.md': plan('1'),
      '01-02-PLAN.md': plan('2', { type: 'execute', dependsOn: '01-01' }),
    };
    withProject(plans, (d) => { commit(d, 'test(01-01): red probe'); commit(d, 'feat(01-02): fix in the dependent plan'); }, (out) => {
      assert.equal(out.violations, 0);
      assert.deepEqual(out.rows[0].greenFrom, ['01-02']);
    });
    withProject(plans, (d) => { commit(d, 'feat(01-02): fix in the dependent plan'); commit(d, 'test(01-01): red probe later'); }, (out) => {
      assert.equal(out.rows[0].status, 'FAIL');
      assert.equal(out.rows[0].reason, 'green_before_red');
    });
  });
});

describe('#5275 commitIsAncestor maps git answers to true / false / null', () => {
  const answer = (exitCode, extra = {}) => () => ({ exitCode, stdout: '', stderr: '', timedOut: false, ...extra });
  const ask = (runner, sha = 'a'.repeat(40), of = 'b'.repeat(40)) => commitIsAncestor(process.cwd(), sha, of, runner);

  test('exit 0 is an ancestor, exit 1 is not', () => {
    assert.equal(ask(answer(0)), true);
    assert.equal(ask(answer(1)), false);
  });

  test('a git that cannot answer (bad object, timeout, missing git) is null, never false', () => {
    assert.equal(ask(answer(128)), null);
    assert.equal(ask(answer(null, { timedOut: true })), null);
    assert.equal(ask(answer(127)), null);
  });

  test('an argument that could read as an option is refused without asking git', () => {
    let asked = false;
    const runner = () => { asked = true; return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
    assert.equal(ask(runner, '--all'), null);
    assert.equal(asked, false);
  });
});
